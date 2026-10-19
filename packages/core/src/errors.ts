export const ErrorCode = {
  VALIDATION: 'VALIDATION',
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  RULE_BLOCKED: 'RULE_BLOCKED',
  RULE_CARD_INVALID: 'RULE_CARD_INVALID',
  RATE_LIMITED: 'RATE_LIMITED',
  BUDGET_EXCEEDED: 'BUDGET_EXCEEDED',
  UPSTREAM_PAYPAL: 'UPSTREAM_PAYPAL',
  UPSTREAM_LLM: 'UPSTREAM_LLM',
  UPSTREAM_CHANNEL3: 'UPSTREAM_CHANNEL3',
  WEBHOOK_UNVERIFIED: 'WEBHOOK_UNVERIFIED',
  STATE_TRANSITION_INVALID: 'STATE_TRANSITION_INVALID',
  CONFIG_INVALID: 'CONFIG_INVALID',
  CONFIG_FORBIDDEN_SECRET: 'CONFIG_FORBIDDEN_SECRET',
  INTERNAL: 'INTERNAL',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

const DEFAULT_HTTP_STATUS: Record<ErrorCode, number> = {
  VALIDATION: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  RULE_BLOCKED: 200,
  RULE_CARD_INVALID: 422,
  RATE_LIMITED: 429,
  BUDGET_EXCEEDED: 429,
  UPSTREAM_PAYPAL: 502,
  UPSTREAM_LLM: 502,
  UPSTREAM_CHANNEL3: 502,
  WEBHOOK_UNVERIFIED: 400,
  STATE_TRANSITION_INVALID: 409,
  CONFIG_INVALID: 500,
  CONFIG_FORBIDDEN_SECRET: 500,
  INTERNAL: 500,
};

export interface AppErrorOptions {
  httpStatus?: number;
  retryable?: boolean;
  details?: Record<string, unknown>;
  cause?: unknown;
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly httpStatus: number;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, opts: AppErrorOptions = {}) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = 'AppError';
    this.code = code;
    this.httpStatus = opts.httpStatus ?? DEFAULT_HTTP_STATUS[code];
    this.retryable = opts.retryable ?? code === ErrorCode.RATE_LIMITED;
    if (opts.details !== undefined) this.details = opts.details;
  }
}

export interface HttpErrorBody {
  error: { code: ErrorCode; message: string; requestId: string };
}

/** Maps any thrown value to an HTTP response. Unknown errors never leak their message. */
export function toHttp(err: unknown, requestId: string): { status: number; body: HttpErrorBody } {
  if (err instanceof AppError) {
    return {
      status: err.httpStatus,
      body: { error: { code: err.code, message: err.message, requestId } },
    };
  }
  return {
    status: DEFAULT_HTTP_STATUS.INTERNAL,
    body: { error: { code: ErrorCode.INTERNAL, message: 'Internal error', requestId } },
  };
}
