import { z } from 'zod';
import * as agent from './routes/agent.js';
import * as events from './routes/events.js';
import * as hijack from './routes/hijack.js';
import * as human from './routes/human.js';
import * as approvals from './routes/human-approvals.js';
import * as internalEval from './routes/internal-eval.js';
import * as push from './routes/push.js';

/**
 * The gateway's OpenAPI 3.1 document, built from the same zod schemas the routes parse with.
 * It describes the routes; it never validates them (each handler keeps its own zod parse, so
 * error bodies stay the AppError shape). Served at /docs outside production and written to
 * docs/openapi.json by scripts/export-openapi.ts.
 */

type Audience = 'agent' | 'human' | 'webhooks' | 'public' | 'internal-eval';
type Method = 'get' | 'post' | 'delete';
type JsonSchema = Record<string, unknown>;

interface RouteDoc {
  method: Method;
  path: string;
  audience: Audience;
  summary: string;
  /** Human assertion scope, when the route needs one. */
  scope?: string;
  security?: string;
  params?: z.ZodType;
  query?: z.ZodType;
  body?: z.ZodType;
  headers?: { name: string; schema: z.ZodType; description: string }[];
  /** Response content type when it is not JSON. */
  produces?: string;
}

const toSchema = (s: z.ZodType): JsonSchema => {
  const { $schema: _drop, ...rest } = z.toJSONSchema(s, { io: 'input', unrepresentable: 'any' });
  return rest as JsonSchema;
};

function parameters(where: 'path' | 'query', s: z.ZodType | undefined) {
  if (!s) return [];
  const json = toSchema(s) as { properties?: Record<string, JsonSchema>; required?: string[] };
  return Object.entries(json.properties ?? {}).map(([name, schema]) => ({
    name,
    in: where,
    required: where === 'path' || (json.required ?? []).includes(name),
    schema,
  }));
}

const humanAssertion = 'humanAssertion';

/** Every route the gateway can mount, grouped by who calls it. */
export const ROUTES: RouteDoc[] = [
  {
    method: 'post',
    path: '/agent/proposals',
    audience: 'agent',
    summary:
      'Propose a purchase. Only product_id and qty are read; price and payee come from the catalog and merchant registry. A blocked proposal is HTTP 200 with decision "blocked" and makes no PayPal call.',
    security: 'agentToken',
    body: agent.ProposalBody,
    headers: [
      {
        name: 'Idempotency-Key',
        schema: agent.IdempotencyKey,
        description: 'Repeats with the same key return the first result.',
      },
    ],
  },
  {
    method: 'get',
    path: '/agent/catalog/search',
    audience: 'agent',
    summary:
      'Search the catalog. Listing text is returned as untrusted_listing_text: data, never instructions.',
    security: 'agentToken',
    query: agent.SearchQuery,
  },
  {
    method: 'get',
    path: '/agent/purchases/{proposalId}',
    audience: 'agent',
    summary: "Status of one of this session's proposals.",
    security: 'agentToken',
    params: agent.ProposalParams,
  },
  {
    method: 'get',
    path: '/agent/rules',
    audience: 'agent',
    summary: 'The signed rules this session runs under (read-only).',
    security: 'agentToken',
  },
  { method: 'get', path: '/human/me', audience: 'human', summary: 'The asserted user.' },
  {
    method: 'post',
    path: '/human/vault/setup-token',
    audience: 'human',
    scope: 'vault:manage',
    summary: 'Start saving a PayPal wallet (Vault v3 setup token); returns the approval link.',
    body: human.SetupTokenBody,
  },
  {
    method: 'post',
    path: '/human/vault/payment-token',
    audience: 'human',
    scope: 'vault:manage',
    summary:
      "Finish saving the wallet. The setup token must be the one created for this user's session.",
    body: human.PaymentTokenBody,
  },
  {
    method: 'delete',
    path: '/human/vault',
    audience: 'human',
    scope: 'vault:manage',
    summary: 'Delete the saved wallet.',
  },
  {
    method: 'post',
    path: '/human/rules/{id}/sign',
    audience: 'human',
    scope: 'rules:sign',
    summary: 'Sign a confirmed rules card.',
    params: human.IdParams,
  },
  {
    method: 'post',
    path: '/human/rules/{id}/revoke',
    audience: 'human',
    scope: 'rules:sign',
    summary: 'Revoke a rules card.',
    params: human.IdParams,
  },
  {
    method: 'post',
    path: '/human/sessions',
    audience: 'human',
    scope: 'sessions:create',
    summary: 'Create an agent session and its agent token.',
    body: human.SessionBody,
  },
  {
    method: 'get',
    path: '/human/approvals',
    audience: 'human',
    scope: 'approvals:decide',
    summary: "List the user's holds.",
    query: approvals.ListQuery,
  },
  {
    method: 'get',
    path: '/human/approvals/{id}',
    audience: 'human',
    scope: 'approvals:decide',
    summary: 'One hold.',
    params: human.IdParams,
  },
  {
    method: 'post',
    path: '/human/approvals/{id}',
    audience: 'human',
    scope: 'approvals:decide',
    summary: 'Approve (capture) or deny (void) a hold.',
    params: human.IdParams,
    body: approvals.DecisionBody,
  },
  {
    method: 'get',
    path: '/human/stats',
    audience: 'human',
    scope: 'approvals:decide',
    summary: "How many of the user's PayPal authorizations are still open.",
  },
  {
    method: 'get',
    path: '/human/proposals',
    audience: 'human',
    scope: 'events:read',
    summary: "The user's recent proposals.",
    query: events.ListQuery,
  },
  {
    method: 'get',
    path: '/human/events',
    audience: 'human',
    scope: 'events:read',
    summary: "Server-sent events for the user's sessions and payments.",
    produces: 'text/event-stream',
  },
  {
    method: 'get',
    path: '/human/merchants/balances',
    audience: 'human',
    scope: 'events:read',
    summary: 'Sandbox merchant balances and Two-Key payments received.',
  },
  {
    method: 'post',
    path: '/human/push-subscriptions',
    audience: 'human',
    scope: 'push:manage',
    summary: 'Register a browser push subscription for hold alerts.',
    body: push.SubscribeBody,
  },
  {
    method: 'delete',
    path: '/human/push-subscriptions',
    audience: 'human',
    scope: 'push:manage',
    summary: 'Remove a browser push subscription.',
    body: push.UnsubscribeBody,
  },
  {
    method: 'post',
    path: '/human/hijack-sessions',
    audience: 'human',
    scope: 'hijack:create',
    summary: 'Start a hijack-box attempt with the given injection text.',
    body: hijack.Body,
  },
  {
    method: 'post',
    path: '/webhooks/paypal',
    audience: 'webhooks',
    summary:
      'PayPal webhook receiver. Applied only after POST /v1/notifications/verify-webhook-signature succeeds; 503 when verification is unreachable so PayPal retries.',
    security: 'paypalSignature',
  },
  {
    method: 'get',
    path: '/public/hijack/{attemptId}/events',
    audience: 'public',
    summary: 'Server-sent events for one hijack-box attempt; t is the attempt token.',
    security: 'attemptToken',
    params: hijack.Params,
    query: hijack.Query,
    produces: 'text/event-stream',
  },
  { method: 'get', path: '/healthz', audience: 'public', summary: 'Liveness.' },
  {
    method: 'get',
    path: '/healthz/deep',
    audience: 'public',
    summary: 'Database, PayPal and webhook-subscription checks.',
  },
  {
    method: 'get',
    path: '/healthz/paypal',
    audience: 'public',
    summary: 'Whether PayPal webhooks are lagging.',
  },
  {
    method: 'get',
    path: '/metrics',
    audience: 'public',
    summary: 'Prometheus metrics.',
    security: 'metricsToken',
    produces: 'text/plain',
  },
  {
    method: 'post',
    path: '/internal/eval/sessions',
    audience: 'internal-eval',
    summary:
      'Create an evaluation session (mode eval: records proposals and gate decisions, never calls PayPal). Mounted only with EVAL_ENABLED=true, never in production.',
    security: 'evalToken',
    body: internalEval.Body,
  },
];

export const AUDIENCES: Record<Audience, string> = {
  agent: 'Called by twokey-mcp with an agent token. Propose and read only.',
  human:
    'Called by web for a signed-in person, with a 60-second Ed25519 assertion carrying the exact scope. Agent tokens (tk_agent_…) are always rejected.',
  webhooks: 'Called by PayPal.',
  public: 'No account needed.',
  'internal-eval': 'The evaluation pipeline only; never mounted in production.',
};

export function buildOpenApiDocument(version = '1.0.0') {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const r of ROUTES) {
    const security = r.security ?? humanAssertion;
    const op: Record<string, unknown> = {
      tags: [r.audience],
      summary: r.summary.split('. ')[0]?.replace(/\.$/, ''),
      description: r.scope ? `${r.summary}\n\nAssertion scope: \`${r.scope}\`.` : r.summary,
      security: r.audience === 'public' && !r.security ? [] : [{ [security]: [] }],
      parameters: [
        ...parameters('path', r.params),
        ...parameters('query', r.query),
        ...(r.headers ?? []).map((h) => ({
          name: h.name,
          in: 'header',
          required: false,
          description: h.description,
          schema: toSchema(h.schema),
        })),
      ],
      responses: {
        '200': {
          description: 'OK',
          content: { [r.produces ?? 'application/json']: {} },
        },
        default: {
          description: 'Error',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
        },
      },
    };
    if (r.body) {
      op.requestBody = {
        required: true,
        content: { 'application/json': { schema: toSchema(r.body) } },
      };
    }
    paths[r.path] = { ...paths[r.path], [r.method]: op };
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'Two-Key gateway',
      version,
      description:
        'The only service that calls PayPal. Every error body is { "error": { "code", "message", "requestId" } }.',
    },
    tags: Object.entries(AUDIENCES).map(([name, description]) => ({ name, description })),
    paths,
    components: {
      securitySchemes: {
        agentToken: {
          type: 'http',
          scheme: 'bearer',
          description: 'Agent token (tk_agent_…) issued for one session.',
        },
        humanAssertion: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description: 'Ed25519 JWT minted by web, valid 60 s, used once, with the exact scope.',
        },
        paypalSignature: {
          type: 'apiKey',
          in: 'header',
          name: 'paypal-transmission-sig',
          description: 'PayPal transmission headers, verified with PayPal before anything applies.',
        },
        attemptToken: {
          type: 'apiKey',
          in: 'query',
          name: 't',
          description: 'Short-lived token for one hijack attempt.',
        },
        metricsToken: { type: 'http', scheme: 'bearer', description: 'METRICS_TOKEN.' },
        evalToken: { type: 'apiKey', in: 'header', name: 'x-eval-token' },
      },
      schemas: {
        Error: {
          type: 'object',
          required: ['error'],
          properties: {
            error: {
              type: 'object',
              required: ['code', 'message', 'requestId'],
              properties: {
                code: { type: 'string' },
                message: { type: 'string' },
                requestId: { type: 'string' },
              },
            },
          },
        },
      },
    },
  };
}
