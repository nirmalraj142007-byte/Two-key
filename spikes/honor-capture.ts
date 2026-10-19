/**
 * Phase 2 follow-up: capture the authorization from vault-spike step g after PayPal's 3-day
 * honor period, and record exactly what PayPal says.
 *
 *   npm run spike:honor
 */
import { AppError } from '@twokey/core';
import { appendSpikeResults, describeError, readResult, setupPayPal, writeResult } from './lib.js';

interface HonorFile {
  authorizationId: string;
  orderId?: string;
  createdAt: string;
  expirationTime?: string | null;
}

const HONOR_MS = 3 * 24 * 60 * 60_000;
const MARGIN_MS = 60 * 60_000;

const honor = readResult<HonorFile>('honor.json');
if (!honor?.authorizationId) {
  console.log('spikes/results/honor.json is missing; run `npm run spike:vault` first.');
  process.exit(1);
}

const earliest = new Date(Date.parse(honor.createdAt) + HONOR_MS + MARGIN_MS);
const now = new Date();
if (now < earliest) {
  console.log(
    `Refusing: authorization ${honor.authorizationId} was created ${honor.createdAt}; ` +
      `the honor period plus 1 hour ends ${earliest.toISOString()}. Run again after that.`,
  );
  process.exit(1);
}

const pp = setupPayPal();
const ageHours = Math.round((now.getTime() - Date.parse(honor.createdAt)) / 3_600_000);
console.log(`Capturing authorization ${honor.authorizationId} (age ${ageHours} h)`);

let statusBefore = 'unknown';
try {
  statusBefore = (await pp.getAuthorization(honor.authorizationId)).status;
  console.log(`authorization status before capture: ${statusBefore}`);
} catch (err) {
  console.log(`could not read authorization: ${describeError(err)}`);
}

let result: Record<string, unknown>;
try {
  const cap = await pp.capture({
    authorizationId: honor.authorizationId,
    requestId: `tk-spike-honor-${honor.authorizationId}-capture`,
  });
  result = { outcome: 'captured', captureId: cap.captureId, captureStatus: cap.status };
  console.log(`CAPTURED: capture ${cap.captureId} status ${cap.status}`);
} catch (err) {
  const d = err instanceof AppError ? (err.details ?? {}) : {};
  result = {
    outcome: 'failed',
    httpStatus: d.httpStatus ?? null,
    name: d.name ?? null,
    issues: d.issues ?? [],
    debug_id: d.debug_id ?? null,
    message: describeError(err),
  };
  console.log(`CAPTURE FAILED: ${describeError(err)}`);
}

const record: Record<string, unknown> = {
  attemptedAt: now.toISOString(),
  authorizationId: honor.authorizationId,
  authorizationCreatedAt: honor.createdAt,
  ageHours,
  statusBefore,
  ...result,
};
writeResult('honor-result.json', record);

const issues = Array.isArray(record.issues) ? record.issues.join(', ') : '';
appendSpikeResults(
  [
    `## Honor-period capture — ${now.toISOString()}`,
    '',
    `- Authorization ${honor.authorizationId}, created ${honor.createdAt} (age ${ageHours} h)`,
    `- Status before capture: ${statusBefore}`,
    record.outcome === 'captured'
      ? `- **Captured**: capture ${String(record.captureId)} status ${String(record.captureStatus)}`
      : `- **Capture failed**: HTTP ${String(record.httpStatus)} ${String(record.name)}` +
        `${issues ? ` (${issues})` : ''}, debug_id ${String(record.debug_id)}`,
  ].join('\n'),
);
console.log('Saved spikes/results/honor-result.json and appended to docs/SPIKE_RESULTS.md');
