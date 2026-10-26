import { z } from 'zod';
import { AppError, ErrorCode } from './errors.js';
import { HONOR_PERIOD_MINUTES } from './rules/schema.js';

export type ServiceName = 'gateway' | 'web' | 'mcp' | 'agent-runner' | 'eval';

const common = {
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
};

const databaseUrl = z.string().min(1);
const nonEmpty = z.string().min(1);
const url = z.url();
const pem = z.string().refine((v) => v.includes('-----BEGIN'), 'must be a PEM block');
const hmacKey = z.string().refine((v) => Buffer.from(v, 'base64').length >= 32, {
  message: 'must be base64 and decode to at least 32 bytes',
});

const schemas = {
  gateway: z.object({
    ...common,
    DATABASE_URL: databaseUrl,
    PAYPAL_ENV: z.enum(['sandbox']),
    PAYPAL_CLIENT_ID: nonEmpty,
    PAYPAL_CLIENT_SECRET: nonEmpty,
    PAYPAL_WEBHOOK_ID: nonEmpty.optional(), // required from phase 4
    RULE_HMAC_KEY: hmacKey,
    RULE_HMAC_KEY_ID: nonEmpty,
    HUMAN_ASSERTION_PUBLIC_KEY: pem,
    AGENT_TOKEN_PEPPER: nonEmpty,
    CHANNEL3_API_KEY: nonEmpty.optional(),
    VAPID_PUBLIC_KEY: nonEmpty,
    VAPID_PRIVATE_KEY: nonEmpty,
    VAPID_SUBJECT: nonEmpty.optional(), // required from phase 18
    WEB_ORIGIN: url,
    PUBLIC_BASE_URL: url,
    PORT: z.coerce.number().int().positive().default(4000),
    /** Hold timeout for demo and hijack sessions; overrides the card's holdTimeoutMinutes. */
    DEMO_HOLD_MINUTES: z.coerce
      .number()
      .int()
      .min(1)
      .max(HONOR_PERIOD_MINUTES - 60)
      .optional(),
    /** Per-merchant PayPal REST credentials, by merchant slug: voids (phase 9), balances (phase 19). */
    MERCHANT_API_CREDENTIALS: z
      .string()
      .transform((v, ctx) => {
        try {
          return JSON.parse(v) as unknown;
        } catch {
          ctx.addIssue({ code: 'custom', message: 'must be valid JSON' });
          return z.NEVER;
        }
      })
      .pipe(z.record(z.string().min(1), z.object({ clientId: nonEmpty, clientSecret: nonEmpty })))
      .optional(),
    /** Mounts POST /internal/eval/sessions. Local only: never set in render.yaml or on Render. */
    EVAL_ENABLED: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
    /** Shared with the eval CLI; sent as x-eval-token. */
    EVAL_ADMIN_TOKEN: z.string().min(32).optional(),
  }),
  web: z.object({
    ...common,
    DATABASE_URL: databaseUrl,
    AUTH_SECRET: nonEmpty,
    HUMAN_ASSERTION_PRIVATE_KEY: pem,
    GATEWAY_URL: url,
    /** Only needed when COMPILER_PROVIDER=anthropic. */
    ANTHROPIC_API_KEY: nonEmpty.optional(),
    /** Rule compiler: any OpenAI-compatible endpoint (default Groq), or Anthropic. */
    COMPILER_PROVIDER: z.enum(['openai-compatible', 'anthropic']).default('openai-compatible'),
    COMPILER_BASE_URL: url.default('https://api.groq.com/openai/v1'),
    COMPILER_API_KEY: nonEmpty.optional(),
    COMPILER_MODEL: nonEmpty.default('openai/gpt-oss-120b'),
    DAILY_BUDGET_USD_LIVE: z.coerce.number().nonnegative().default(2),
    NEXT_PUBLIC_AG_GRID_LICENSE_KEY: nonEmpty.optional(),
    NEXT_PUBLIC_VAPID_PUBLIC_KEY: nonEmpty.optional(),
    IP_HASH_SALT: nonEmpty,
  }),
  mcp: z.object({
    ...common,
    DATABASE_URL: databaseUrl.optional(), // mcp talks only to the gateway
    GATEWAY_URL: url,
    TWOKEY_AGENT_TOKEN: nonEmpty.optional(), // stdio mode
    PORT: z.coerce.number().int().positive().default(4100),
  }),
  'agent-runner': z.object({
    ...common,
    DATABASE_URL: databaseUrl,
    /** Only needed for claude-* models. */
    ANTHROPIC_API_KEY: nonEmpty.optional(),
    /** OpenAI-compatible endpoint for every other model (default Groq). */
    AGENT_LLM_BASE_URL: url.default('https://api.groq.com/openai/v1'),
    AGENT_LLM_API_KEY: nonEmpty.optional(),
    /**
     * Model and provider for live, demo and hijack sessions. Until the test split is done
     * (Nov 7) they run gpt-oss-20b on NIM so development never uses the Groq allowance kept for
     * the gpt-oss-120b test runs; switch back to openai/gpt-oss-120b on groq afterwards.
     */
    AGENT_MODEL: nonEmpty.default('openai/gpt-oss-20b'),
    AGENT_PROVIDER: z.enum(['groq', 'nim']).default('nim'),
    /** OpenAI-compatible endpoint for NIM (eval sessions, and live ones while AGENT_PROVIDER=nim). */
    EVAL_LLM_BASE_URL: url.default('https://integrate.api.nvidia.com/v1'),
    EVAL_LLM_API_KEY: nonEmpty.optional(),
    /** Checked for pricing at startup so an eval run cannot start with an unpriced model. */
    EVAL_MODELS: nonEmpty.default(
      'openai/gpt-oss-120b,openai/gpt-oss-20b,nvidia/nemotron-3.5-bolt-e4b',
    ),
    MCP_URL: url,
    DAILY_BUDGET_USD_LIVE: z.coerce.number().nonnegative().default(5),
    DAILY_BUDGET_USD_HIJACK: z.coerce.number().nonnegative().default(10),
    DAILY_BUDGET_USD_EVAL: z.coerce.number().nonnegative().default(100),
    PORT: z.coerce.number().int().positive().default(4200),
  }),
  eval: z.object({
    ...common,
    DATABASE_URL: databaseUrl,
    ANTHROPIC_API_KEY: nonEmpty.optional(),
    AGENT_LLM_BASE_URL: url.default('https://api.groq.com/openai/v1'),
    AGENT_LLM_API_KEY: nonEmpty.optional(),
    /** Evaluation models are served by NVIDIA NIM's OpenAI-compatible API. */
    EVAL_LLM_BASE_URL: url.default('https://integrate.api.nvidia.com/v1'),
    EVAL_LLM_API_KEY: nonEmpty,
    /** Comma list of evaluation models. */
    EVAL_MODELS: nonEmpty.default(
      'openai/gpt-oss-120b,openai/gpt-oss-20b,nvidia/nemotron-3.5-bolt-e4b',
    ),
    COMPILER_API_KEY: nonEmpty.optional(),
    CHANNEL3_API_KEY: nonEmpty,
    GATEWAY_URL: url,
    MCP_URL: url,
    EVAL_ADMIN_TOKEN: z.string().min(32).optional(),
    /** The model the Oct 29 checkpoint looks at. */
    EVAL_WEAK_MODEL: nonEmpty.default('nvidia/nemotron-3.5-bolt-e4b'),
    /** Daily cap for budget scope 'eval'. */
    EVAL_BUDGET_USD: z.coerce.number().nonnegative().default(25),
  }),
} satisfies Record<ServiceName, z.ZodObject>;

export type Env<S extends ServiceName> = z.infer<(typeof schemas)[S]>;

/** Which services may hold each secret. Source of truth for `check:secrets`. */
export const SECRET_OWNERS: Record<string, ServiceName[]> = {
  PAYPAL_CLIENT_SECRET: ['gateway'],
  RULE_HMAC_KEY: ['gateway'],
  AGENT_TOKEN_PEPPER: ['gateway'],
  VAPID_PRIVATE_KEY: ['gateway'],
  MERCHANT_API_CREDENTIALS: ['gateway'],
  CHANNEL3_API_KEY: ['gateway', 'eval'],
  HUMAN_ASSERTION_PRIVATE_KEY: ['web'],
  AUTH_SECRET: ['web'],
  ANTHROPIC_API_KEY: ['web', 'agent-runner', 'eval'],
  COMPILER_API_KEY: ['web', 'eval'],
  AGENT_LLM_API_KEY: ['agent-runner', 'eval'],
  EVAL_LLM_API_KEY: ['agent-runner', 'eval'],
  NIM_API_KEY: ['agent-runner', 'eval'],
  EVAL_ADMIN_TOKEN: ['gateway', 'eval'],
};

export function loadEnv<S extends ServiceName>(
  service: S,
  source: Record<string, string | undefined> = process.env,
): Env<S> {
  for (const [name, owners] of Object.entries(SECRET_OWNERS)) {
    const value = source[name];
    if (value !== undefined && value !== '' && !owners.includes(service)) {
      throw new AppError(
        ErrorCode.CONFIG_FORBIDDEN_SECRET,
        `${name} may only be set on: ${owners.join(', ')}`,
      );
    }
  }

  // Empty strings (as in a copied .env.example) count as unset.
  const input: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && value !== '') input[key] = value;
  }

  const result = schemas[service].safeParse(input);
  if (!result.success) {
    const missing = new Set<string>();
    const invalid = new Set<string>();
    for (const issue of result.error.issues) {
      const key = String(issue.path[0] ?? '(root)');
      (input[key] === undefined ? missing : invalid).add(key);
    }
    const parts: string[] = [];
    if (missing.size) parts.push(`missing: ${[...missing].join(', ')}`);
    if (invalid.size) parts.push(`invalid: ${[...invalid].join(', ')}`);
    throw new AppError(
      ErrorCode.CONFIG_INVALID,
      `Invalid environment for ${service} (${parts.join('; ')})`,
      { details: { missing: [...missing], invalid: [...invalid] } },
    );
  }
  return result.data as Env<S>;
}
