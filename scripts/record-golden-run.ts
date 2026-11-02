/**
 * npm run demo:record-golden — records the demo's three beats against the LOCAL dev stack
 * (gateway :4000, agent-runner :4200) with scripted models, for the console's replay fallback:
 *
 *   1. happy    scripted:happy    Cloud Runner CR-1 at Stride Supply, captured
 *   2. attack   scripted:attack   the agent follows the listing; the gift card is blocked
 *   3. anomaly  scripted:anomaly  Trail Runner TR-2 at Peak Outfitters held, then denied (voided)
 *
 * It signs in as maya@twokey.demo the way web does (60-second assertions from .env.web's key),
 * listens to GET /human/events, starts each run on the runner's scripted queue, denies the hold,
 * and writes every stream event with its time since the beat started to
 * apps/web/public/golden-run.json. Our IDs become REPLAY-<kind>-<n> and PayPal IDs get a
 * "REPLAY-" prefix, so nothing in the file can be taken for a live record.
 *
 * Local only: refuses a non-local database or gateway, and the evaluation stack's ports.
 * Run `npm run demo:setup -- --env local` first (maya needs a wallet and the demo card).
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { createDb, pgBossConnection, users } from '@twokey/db';
import { eq } from 'drizzle-orm';
import { importPKCS8, SignJWT } from 'jose';
import { PgBoss } from 'pg-boss';

const ROOT = join(import.meta.dirname, '..');
const OUT = join(ROOT, 'apps', 'web', 'public', 'golden-run.json');
const EMAIL = 'maya@twokey.demo';
const SCRIPTED_QUEUE = 'agent.run.app.scripted'; // apps/agent-runner/src/worker.ts
const DEMO_REQUEST =
  'Running shoes, size 10, under $70, only Stride Supply or Peak Outfitters, one pair, this week.';
const BEATS = [
  { name: 'happy', model: 'scripted:happy', message: DEMO_REQUEST },
  { name: 'attack', model: 'scripted:attack', message: DEMO_REQUEST },
  {
    name: 'anomaly',
    model: 'scripted:anomaly',
    message: 'Trail Runner TR-2, under $70, one pair.',
  },
] as const;
const BEAT_TIMEOUT_MS = 120_000;
const DENY_AFTER_MS = 4_000;
const FINAL = new Set(['captured', 'voided', 'expired', 'denied', 'failed', 'blocked', 'recorded']);

const read = (name: string) => parseEnv(readFileSync(join(ROOT, name), 'utf8'));
const privatePem = read('.env.web').HUMAN_ASSERTION_PRIVATE_KEY;
const databaseUrl = read('.env.gateway').DATABASE_URL;
const gatewayUrl = process.env.GOLDEN_GATEWAY_URL ?? 'http://localhost:4000';
if (!privatePem || !databaseUrl) {
  console.error('needs HUMAN_ASSERTION_PRIVATE_KEY in .env.web and DATABASE_URL in .env.gateway');
  process.exit(1);
}
const local = (u: string) => ['localhost', '127.0.0.1', '[::1]'].includes(new URL(u).hostname);
if (!local(databaseUrl) || !local(gatewayUrl) || new URL(gatewayUrl).port === '4010') {
  console.error('demo:record-golden runs only against the local dev stack (gateway :4000)');
  process.exit(1);
}

const { db, sql } = createDb(databaseUrl);
const key = await importPKCS8(privatePem, 'EdDSA');
const [maya] = await db
  .select({ id: users.id, role: users.role })
  .from(users)
  .where(eq(users.email, EMAIL));
if (!maya) {
  console.error(`no ${EMAIL}: run npm run demo:setup -- --env local`);
  process.exit(1);
}
const me = maya;

async function assertion(scope: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ role: me.role, scope })
    .setProtectedHeader({ alg: 'EdDSA' })
    .setIssuer('twokey-web')
    .setAudience('twokey-gateway')
    .setSubject(me.id)
    .setJti(randomUUID())
    .setIssuedAt(now)
    .setExpirationTime(now + 60)
    .sign(key);
}

async function gateway<T>(path: string, scope: string, body: unknown): Promise<T> {
  const res = await fetch(new URL(path, gatewayUrl), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${await assertion(scope)}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as T;
  if (!res.ok) throw new Error(`${path} answered ${res.status}: ${JSON.stringify(json)}`);
  return json;
}

interface Recorded {
  t: number;
  event: string;
  data: Record<string, unknown>;
}
type Listener = (e: { event: string; data: Record<string, unknown> }) => void;
const listeners = new Set<Listener>();

/** GET /human/events, parsed frame by frame; every event goes to the current listeners. */
async function openStream(signal: AbortSignal): Promise<void> {
  const res = await fetch(new URL('/human/events', gatewayUrl), {
    headers: { authorization: `Bearer ${await assertion('events:read')}` },
    signal,
  });
  if (!res.ok || !res.body) throw new Error(`events stream refused (${res.status})`);
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = '';
  void (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buf += value;
        let end = buf.indexOf('\n\n');
        while (end !== -1) {
          const frame = buf.slice(0, end);
          buf = buf.slice(end + 2);
          end = buf.indexOf('\n\n');
          let event = 'message';
          const data: string[] = [];
          for (const line of frame.split('\n')) {
            if (line.startsWith('event:')) event = line.slice(6).trim();
            else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
          }
          if (data.length === 0) continue;
          try {
            const parsed = JSON.parse(data.join('\n')) as Record<string, unknown>;
            for (const l of listeners) l({ event, data: parsed });
          } catch {
            // heartbeat or non-JSON frame
          }
        }
      }
    } catch {
      // aborted at the end of the recording
    }
  })();
}

const boss = new PgBoss({
  ...pgBossConnection(databaseUrl, 'twokey-golden'),
  supervise: false,
  schedule: false,
});
await boss.start();
if (!(await boss.getQueue(SCRIPTED_QUEUE)))
  await boss.createQueue(SCRIPTED_QUEUE, { retryLimit: 0 });

async function recordBeat(beat: (typeof BEATS)[number]) {
  const events: Recorded[] = [];
  const start = Date.now();
  const { sessionId, token } = await gateway<{ sessionId: string; token: string }>(
    '/human/sessions',
    'sessions:create',
    { mode: 'demo', model: beat.model },
  );
  const states = new Map<string, string>();
  let denied = false;
  const done = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${beat.name} did not finish`)),
      BEAT_TIMEOUT_MS,
    );
    const check = async () => {
      const [row] = await sql<
        { status: string }[]
      >`select status from agent_sessions where id = ${sessionId}`;
      const ended = row && row.status !== 'active';
      if (ended && states.size > 0 && [...states.values()].every((s) => FINAL.has(s))) {
        clearTimeout(timer);
        listeners.delete(listener);
        clearInterval(poll);
        resolve();
      }
    };
    const listener: Listener = (e) => {
      const d = e.data;
      const own =
        d.sessionId === sessionId || (typeof d.proposalId === 'string' && states.has(d.proposalId));
      if (!own) return;
      events.push({ t: Date.now() - start, event: e.event, data: d });
      if (typeof d.proposalId === 'string' && typeof d.state === 'string') {
        states.set(d.proposalId, d.state);
      }
      if (e.event === 'approval.created' && !denied && typeof d.approvalId === 'string') {
        denied = true;
        const id = d.approvalId;
        setTimeout(() => {
          gateway(`/human/approvals/${id}`, 'approvals:decide', {
            decision: 'deny',
            via: 'web',
          }).catch(reject);
        }, DENY_AFTER_MS);
      }
    };
    listeners.add(listener);
    const poll = setInterval(() => void check().catch(reject), 1000);
  });
  await boss.send(SCRIPTED_QUEUE, {
    sessionId,
    userId: me.id,
    token,
    userMessage: beat.message,
    model: beat.model,
    mode: 'demo',
  });
  await done;
  // Late snapshots (approval.decided after the void) arrive within a moment.
  await new Promise((r) => setTimeout(r, 1500));
  return { name: beat.name, model: beat.model, message: beat.message, events, start };
}

/** Our UUIDs -> REPLAY-<kind>-<n>; PayPal IDs -> REPLAY-<id>. Applied to the whole file. */
function sanitize(json: string, recorded: Awaited<ReturnType<typeof recordBeat>>[]): string {
  const paypal = new Set<string>();
  const kinds = new Map<string, string>();
  for (const b of recorded) {
    for (const { data } of b.events) {
      for (const f of ['orderId', 'authorizationId', 'captureId']) {
        if (typeof data[f] === 'string') paypal.add(data[f] as string);
      }
      for (const [f, kind] of [
        ['sessionId', 'session'],
        ['proposalId', 'proposal'],
        ['paymentId', 'payment'],
        ['approvalId', 'approval'],
      ] as const) {
        const v = data[f];
        if (typeof v === 'string' && !kinds.has(v)) kinds.set(v, kind);
      }
    }
  }
  let out = json;
  for (const id of paypal) out = out.split(id).join(`REPLAY-${id}`);
  const counter = new Map<string, number>();
  const alias = new Map<string, string>();
  out = out.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, (uuid) => {
    const known = alias.get(uuid);
    if (known) return known;
    const kind = kinds.get(uuid) ?? 'id';
    const n = (counter.get(kind) ?? 0) + 1;
    counter.set(kind, n);
    const a = `REPLAY-${kind}-${n}`;
    alias.set(uuid, a);
    return a;
  });
  return out;
}

const ctrl = new AbortController();
try {
  await openStream(ctrl.signal);
  await new Promise((r) => setTimeout(r, 500));
  const recorded = [];
  for (const beat of BEATS) {
    process.stdout.write(`recording ${beat.name}… `);
    const r = await recordBeat(beat);
    recorded.push(r);
    const last = [...r.events].reverse().find((e) => typeof e.data.state === 'string');
    console.log(
      `${r.events.length} events, ends ${String(last?.data.state ?? '?')} after ${r.events.at(-1)?.t ?? 0} ms`,
    );
  }
  const file = {
    note: 'Recorded with scripted models against the local dev stack (npm run demo:record-golden). Replayed only under the banner "Replaying a recorded run".',
    recordedAt: new Date(recorded[0]?.start ?? Date.now()).toISOString(),
    beats: recorded.map(({ name, model, message, events, start }) => ({
      name,
      model,
      message,
      startedAt: new Date(start).toISOString(),
      events,
    })),
  };
  writeFileSync(OUT, `${sanitize(JSON.stringify(file, null, 1), recorded)}\n`);
  // Formatted as the repo's Biome config wants, so `npm run check` stays green.
  const biome = join(ROOT, 'node_modules', '@biomejs', 'biome', 'bin', 'biome');
  execFileSync(process.execPath, [biome, 'format', '--write', OUT], { stdio: 'ignore' });
  console.log(`wrote ${OUT}`);
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  ctrl.abort();
  await boss.stop({ graceful: false });
  await sql.end();
}
