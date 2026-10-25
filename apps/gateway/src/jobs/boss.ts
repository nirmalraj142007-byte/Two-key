import { pgBossConnection, startWithRetry } from '@twokey/db';
import type { FastifyInstance } from 'fastify';
import { PgBoss, type Queue } from 'pg-boss';
import { processPendingWebhooks } from '../services/webhook-apply.js';
import { handleHoldTimeout } from './hold-timeout.js';
import { type JobDeps, type Jobs, type Logger, QUEUES, type QueueName } from './queue.js';
import { reconcilePayment } from './reconcile.js';
import { runSweep } from './sweep.js';

declare module 'fastify' {
  interface FastifyInstance {
    jobs: Jobs;
    /** Null when the app has no database or no PayPal client: no workers can run. */
    jobDeps: JobDeps | null;
  }
}

const RETRY = { retryLimit: 5, retryBackoff: true } as const;

// `exclusive`: at most one queued-or-active job per singletonKey (one timer per hold).
// `stately`: one queued plus one active per key, so a reconcile sent while another runs is kept.
const QUEUE_OPTIONS: Record<QueueName, Omit<Queue, 'name'>> = {
  'hold.timeout': { policy: 'exclusive', ...RETRY },
  'payment.reconcile': { policy: 'stately', ...RETRY },
  'webhook.pending': { policy: 'stately', ...RETRY },
  'sweep.open-auths': { policy: 'exclusive', ...RETRY },
};

export interface JobRunner extends Jobs {
  /** Starts pg-boss (once) and creates every queue. Sends start it lazily too. */
  boss(): Promise<PgBoss>;
  stop(): Promise<void>;
}

/** pg-boss on the gateway's own database. Nothing connects until the first send or start. */
export function createJobRunner(url: string, log: Logger): JobRunner {
  let started: Promise<PgBoss> | undefined;
  let stopped = false;

  async function start(): Promise<PgBoss> {
    let boss = new PgBoss(pgBossConnection(url, 'twokey-gateway'));
    boss.on('error', (err) => log.error({ err }, 'pg-boss error'));
    await startWithRetry(
      () => boss.start(),
      async () => {
        await boss.stop({ graceful: false });
        boss = new PgBoss(pgBossConnection(url, 'twokey-gateway'));
        boss.on('error', (err) => log.error({ err }, 'pg-boss error'));
      },
      (err, attempt) => log.warn({ err, attempt }, 'pg-boss start failed, retrying'),
    );
    for (const [name, options] of Object.entries(QUEUE_OPTIONS)) {
      if (!(await boss.getQueue(name))) await boss.createQueue(name, options);
    }
    return boss;
  }

  const runner: JobRunner = {
    boss() {
      if (stopped) return Promise.reject(new Error('job runner is stopped'));
      started ??= start().catch((err) => {
        started = undefined; // let the next call try again
        throw err;
      });
      return started;
    },
    async send(name, data, opts = {}) {
      const boss = await runner.boss();
      await boss.send(name, data, {
        ...(opts.startAfter !== undefined ? { startAfter: opts.startAfter } : {}),
        ...(opts.singletonKey ? { singletonKey: opts.singletonKey } : {}),
      });
    },
    async stop() {
      stopped = true;
      const boss = await started?.catch(() => undefined);
      await boss?.stop({ graceful: true, timeout: 10_000 });
    },
  };
  return runner;
}

function isRunner(jobs: Jobs): jobs is JobRunner {
  return typeof (jobs as Partial<JobRunner>).boss === 'function';
}

/**
 * Registers the workers and schedules, then queues one sweep for boot. Handlers log failures
 * with the payment ID and rethrow, so pg-boss records the failure and retries (5×, backoff).
 */
export async function startJobs(app: FastifyInstance): Promise<void> {
  const deps = app.jobDeps;
  if (!deps || !isRunner(app.jobs)) {
    app.log.warn('jobs not started: the gateway has no database or no PayPal client');
    return;
  }
  const boss = await app.jobs.boss();
  const log = app.log.child({ component: 'jobs' });

  async function each<T extends Record<string, unknown>>(
    queue: QueueName,
    jobs: Array<{ id: string; data: T }>,
    run: (data: T) => Promise<unknown>,
  ): Promise<void> {
    for (const job of jobs) {
      try {
        await run(job.data);
      } catch (err) {
        log.error({ queue, jobId: job.id, paymentId: job.data.paymentId, err }, 'job failed');
        throw err;
      }
    }
  }

  const jobDeps: JobDeps = { ...deps, log };
  await boss.work<{ paymentId: string }>(QUEUES.holdTimeout, (jobs) =>
    each(QUEUES.holdTimeout, jobs, (d) => handleHoldTimeout(jobDeps, d)),
  );
  await boss.work<{ paymentId: string }>(QUEUES.reconcile, (jobs) =>
    each(QUEUES.reconcile, jobs, (d) => reconcilePayment(jobDeps, d.paymentId)),
  );
  await boss.work<Record<string, never>>(QUEUES.webhookPending, (jobs) =>
    each(QUEUES.webhookPending, jobs, () => processPendingWebhooks(deps.db, log)),
  );
  await boss.work<Record<string, never>>(QUEUES.sweep, (jobs) =>
    each(QUEUES.sweep, jobs, () => runSweep(jobDeps)),
  );

  await boss.schedule(QUEUES.webhookPending, '* * * * *');
  await boss.schedule(QUEUES.sweep, '0 3 * * *', {}, { tz: 'UTC' });
  await boss.send(QUEUES.sweep, {}, { singletonKey: 'boot' });
  log.info({ queues: Object.values(QUEUES) }, 'jobs started');
}
