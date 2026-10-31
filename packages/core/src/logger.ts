import pino, { type DestinationStream, type Logger } from 'pino';
import type { ServiceName } from './env.js';
import { currentLogContext } from './log-context.js';

export const REDACT_PATHS = [
  '*.authorization',
  '*.Authorization',
  'headers.authorization',
  '*.token',
  '*.password',
  '*.vault_id',
  '*.vaultId',
  '*.payment_token_id',
  '*.paymentTokenId',
  '*.PAYPAL_CLIENT_SECRET',
  '*.RULE_HMAC_KEY',
  '*.secret',
];

/**
 * Adds the current request's or job's context (requestId, userIdHash, sessionId, proposalId,
 * paymentId) to each line, skipping keys the line or the child logger already carries so no
 * key appears twice in the JSON.
 */
function contextMixin(merge: object, _level: number, logger: Logger): object {
  const ctx = currentLogContext();
  const keys = Object.keys(ctx) as Array<keyof typeof ctx>;
  if (keys.length === 0) return {};
  const bound = logger.bindings();
  const out: Record<string, string> = {};
  for (const k of keys) {
    const v = ctx[k];
    if (v !== undefined && !(k in merge) && !(k in bound)) out[k] = v;
  }
  return out;
}

/**
 * JSON logs on stdout. With LOG_FILE set (local runs only), each line also goes to that file,
 * so one purchase can be traced with `grep <requestId> logs/*.log`.
 */
function defaultDestination(): DestinationStream | undefined {
  const file = process.env.LOG_FILE;
  if (!file) return undefined;
  return pino.multistream([
    { stream: process.stdout },
    { stream: pino.destination({ dest: file, mkdir: true, sync: true }) },
  ]);
}

export function createLogger(
  service: ServiceName,
  level = 'info',
  destination?: DestinationStream,
): Logger {
  const options = {
    level,
    base: { service },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: { paths: REDACT_PATHS, censor: '[Redacted]' },
    mixin: contextMixin,
  };
  const dest = destination ?? defaultDestination();
  return dest ? pino(options, dest) : pino(options);
}
