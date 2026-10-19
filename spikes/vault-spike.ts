/**
 * Phase 2 spike against the REAL PayPal sandbox: can the gateway authorize, capture and void
 * on a buyer's vaulted PayPal wallet with no buyer present?
 *
 *   npm run spike:vault            full run (buyer approves the setup token in a browser)
 *   npm run spike:vault -- --reuse reuse spikes/results/vault.json, skip steps a–c
 */
import { randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { AppError } from '@twokey/core';
import { PAYER_ACTION_MESSAGE } from '@twokey/paypal';
import {
  appendSpikeResults,
  describeError,
  errorDetails,
  readMerchants,
  readResult,
  setupPayPal,
  writeResult,
} from './lib.js';

interface VaultFile {
  paymentTokenId: string;
  customerId: string;
  createdAt: string;
}

interface StepLine {
  step: string;
  ok: boolean;
  text: string;
  error?: Record<string, unknown>;
}

const POLL_MS = 3_000;
const POLL_LIMIT_MS = 5 * 60_000;
const ONE_DOLLAR = 100;

const reuse = process.argv.includes('--reuse');
const startedAt = new Date();
const runId = `${startedAt.toISOString().replace(/\D/g, '').slice(0, 14)}-${randomBytes(2).toString('hex')}`;
const lines: StepLine[] = [];
let payerActionSeen = false;

function record(step: string, ok: boolean, text: string, err?: unknown): void {
  const line: StepLine = {
    step,
    ok,
    text,
    ...(err === undefined ? {} : { error: errorDetails(err) }),
  };
  lines.push(line);
  console.log(`[${step}] ${ok ? 'OK  ' : 'FAIL'} ${text}`);
  if (err !== undefined) console.log(`[${step}]      details: ${JSON.stringify(line.error)}`);
}

function fail(step: string, err: unknown): void {
  if (err instanceof AppError && err.message === PAYER_ACTION_MESSAGE) {
    payerActionSeen = true;
    console.log('');
    console.log('!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!');
    console.log(`!!! PAYER_ACTION_REQUIRED on a vaulted order (step ${step}) — CONCEPT KILLER !!!`);
    console.log('!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!');
    console.log('');
  }
  record(step, false, describeError(err), err);
}

const pp = setupPayPal();
const stride = readMerchants().find((m) => m.slug === 'stride-supply');
const reqId = (order: string, op: string) => `tk-spike-${runId}-${order}-${op}`;

console.log(`Two-Key vault spike — run ${runId}${reuse ? ' (--reuse)' : ''}`);

// ---- a–c: vault the buyer's wallet ---------------------------------------------------------
let vaultId: string | undefined;

if (reuse) {
  const saved = readResult<VaultFile>('vault.json');
  if (saved?.paymentTokenId) {
    vaultId = saved.paymentTokenId;
    record(
      'a-c',
      true,
      `reusing payment token from spikes/results/vault.json (created ${saved.createdAt})`,
    );
  } else {
    record('a-c', false, 'spikes/results/vault.json is missing; run without --reuse first');
  }
} else {
  let setupTokenId: string | undefined;
  try {
    const st = await pp.createSetupToken({
      returnUrl: 'http://localhost:3000/spike/return',
      cancelUrl: 'http://localhost:3000/spike/cancel',
      requestId: `tk-spike-${runId}-setup-token`,
    });
    setupTokenId = st.id;
    record('a', true, `setup token ${st.id} status ${st.status}`);
    console.log(`[a]      approveUrl: ${st.approveUrl}`);
    console.log('[a]      Log in as the sandbox BUYER and approve');
  } catch (err) {
    fail('a', err);
  }

  if (setupTokenId) {
    const seen: string[] = [];
    const deadline = Date.now() + POLL_LIMIT_MS;
    let approved = false;
    while (Date.now() < deadline) {
      try {
        const { status } = await pp.getSetupToken(setupTokenId);
        if (seen.at(-1) !== status) {
          seen.push(status);
          console.log(`[b]      status: ${status}`);
        }
        if (status === 'APPROVED') {
          approved = true;
          break;
        }
      } catch (err) {
        console.log(`[b]      poll error: ${describeError(err)}`);
      }
      await sleep(POLL_MS);
    }
    record(
      'b',
      approved,
      approved
        ? `setup token APPROVED (statuses seen: ${seen.join(' -> ')})`
        : `not APPROVED within 5 minutes (statuses seen: ${seen.join(' -> ') || 'none'})`,
    );

    if (approved) {
      try {
        const pt = await pp.createPaymentToken({
          setupTokenId,
          requestId: `tk-spike-${runId}-payment-token`,
        });
        vaultId = pt.paymentTokenId;
        writeResult('vault.json', {
          ...pt,
          createdAt: new Date().toISOString(),
        } satisfies VaultFile);
        record(
          'c',
          true,
          `payment token created (customer ${pt.customerId ? 'present' : 'MISSING'}); saved to spikes/results/vault.json`,
        );
      } catch (err) {
        fail('c', err);
      }
    }
  }
}

// ---- d–g: merchant-initiated orders on the vaulted wallet ----------------------------------
function authorize(order: string, payeeMerchantId?: string) {
  if (!vaultId) throw new Error('no vault id');
  return pp.createVaultedAuthorization({
    requestId: reqId(order, 'create'),
    vaultId,
    referenceId: `spike-${runId}-${order}`,
    amountCents: ONE_DOLLAR,
    item: {
      name: `Two-Key spike order ${order}`,
      sku: `SPIKE-${order}`,
      qty: 1,
      unitAmountCents: ONE_DOLLAR,
    },
    ...(payeeMerchantId ? { payeeMerchantId } : {}),
  });
}

const captured = (status: string) => status === 'COMPLETED' || status === 'PENDING';

let dOk = false;
let eOk = false;
let ladder = 'LADDER_A_FAILED: not run';
let honorAuthId: string | undefined;

if (!vaultId) {
  for (const s of ['d', 'e', 'f', 'g']) record(s, false, 'skipped: no vaulted payment token');
} else {
  // d. capture + idempotent replay
  try {
    const a = await authorize('A');
    record(
      'd',
      true,
      `order A ${a.orderId} ${a.orderStatus}; authorization ${a.authorizationId} ${a.authorizationStatus}`,
    );
    const c = await pp.capture({
      authorizationId: a.authorizationId,
      requestId: reqId('A', 'capture'),
    });
    record('d', captured(c.status), `capture ${c.captureId} ${c.status}`);
    const again = await authorize('A');
    const same = again.orderId === a.orderId;
    record(
      'd',
      same,
      `replay with same PayPal-Request-Id -> order ${again.orderId} (${same ? 'same order' : 'DIFFERENT order'})`,
    );
    dOk = captured(c.status) && same;
  } catch (err) {
    fail('d', err);
  }

  // e. void
  try {
    const b = await authorize('B');
    record(
      'e',
      true,
      `order B ${b.orderId} ${b.orderStatus}; authorization ${b.authorizationId} ${b.authorizationStatus}`,
    );
    await pp.voidAuthorization({
      authorizationId: b.authorizationId,
      requestId: reqId('B', 'void'),
    });
    const after = await pp.getAuthorization(b.authorizationId);
    eOk = after.status === 'VOIDED';
    record('e', eOk, `void -> authorization status ${after.status}`);
  } catch (err) {
    fail('e', err);
  }

  // f. explicit payee (ladder rung A: platform pays a different sandbox merchant)
  if (!stride) {
    record('f', false, 'stride-supply missing from config/merchants.json');
    ladder = 'LADDER_A_FAILED: stride-supply missing from config/merchants.json';
  } else {
    try {
      const c = await authorize('C', stride.paypalMerchantId);
      record(
        'f',
        true,
        `order C ${c.orderId} payee ${stride.displayName}; authorization ${c.authorizationId} ${c.authorizationStatus}`,
      );
      const cap = await pp.capture({
        authorizationId: c.authorizationId,
        requestId: reqId('C', 'capture'),
      });
      const ok = captured(cap.status);
      record('f', ok, `capture ${cap.captureId} ${cap.status}`);
      ladder = ok ? 'LADDER_A_OK' : `LADDER_A_FAILED: capture status ${cap.status}`;
    } catch (err) {
      fail('f', err);
      const d = err instanceof AppError ? (err.details ?? {}) : {};
      const issues = Array.isArray(d.issues) ? d.issues.join(',') : '';
      ladder = `LADDER_A_FAILED: ${String(d.name ?? describeError(err))}/${issues || '-'}/${String(d.debug_id ?? '-')}`;
    }
  }

  // g. authorize only, for the honor-period capture spike
  try {
    const dd = await authorize('D');
    const info = await pp.getAuthorization(dd.authorizationId);
    honorAuthId = dd.authorizationId;
    writeResult('honor.json', {
      authorizationId: dd.authorizationId,
      orderId: dd.orderId,
      createdAt: new Date().toISOString(),
      expirationTime: info.expirationTime ?? dd.expirationTime ?? null,
    });
    record(
      'g',
      true,
      `order D ${dd.orderId}; authorization ${dd.authorizationId} ${info.status} (expires ${info.expirationTime ?? 'n/a'}); saved to spikes/results/honor.json`,
    );
  } catch (err) {
    fail('g', err);
  }
}

// ---- h: verdict ----------------------------------------------------------------------------
const reasons: string[] = [];
if (payerActionSeen) reasons.push('a vaulted order returned PAYER_ACTION_REQUIRED');
if (!vaultId) reasons.push('no vaulted payment token');
else {
  if (!dOk) reasons.push('order A capture/idempotency failed');
  if (!eOk) reasons.push('order B void failed');
}
const verdict = reasons.length === 0 ? 'GO' : `NO-GO: ${reasons.join('; ')}`;

console.log('');
console.log('Step  Result  Detail');
console.log('----  ------  ------------------------------------------------------------');
for (const l of lines)
  console.log(`${l.step.padEnd(4)}  ${(l.ok ? 'OK' : 'FAIL').padEnd(6)}  ${l.text}`);
console.log('');
console.log(ladder);
console.log(verdict);

const md = [
  `## Vault spike — ${startedAt.toISOString()} (run \`${runId}\`${reuse ? ', --reuse' : ''})`,
  '',
  '| Step | Result | Detail |',
  '| --- | --- | --- |',
  ...lines.map((l) => {
    const detail = l.error ? `${l.text} — \`${JSON.stringify(l.error)}\`` : l.text;
    return `| ${l.step} | ${l.ok ? 'OK' : 'FAIL'} | ${detail.replaceAll('|', '\\|')} |`;
  }),
  '',
  `- Honor-period authorization: ${honorAuthId ?? 'none'}`,
  `- ${ladder}`,
  `- **${verdict}**`,
].join('\n');
appendSpikeResults(md);
console.log('Appended to docs/SPIKE_RESULTS.md');

process.exitCode = verdict === 'GO' ? 0 : 1;
