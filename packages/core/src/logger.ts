import pino, { type DestinationStream, type Logger } from 'pino';
import type { ServiceName } from './env.js';

export const REDACT_PATHS = [
  '*.authorization',
  '*.Authorization',
  'headers.authorization',
  '*.token',
  '*.password',
  '*.vault_id',
  '*.vaultId',
  '*.payment_token_id',
  '*.PAYPAL_CLIENT_SECRET',
  '*.RULE_HMAC_KEY',
  '*.secret',
];

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
  };
  return destination ? pino(options, destination) : pino(options);
}
