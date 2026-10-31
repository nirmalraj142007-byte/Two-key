# Operations

How to follow one purchase through the logs, how the services are monitored, and what each
alert means. Deployment itself is in [DEPLOY.md](DEPLOY.md); security checks are in
[SECURITY.md](SECURITY.md).

## Request IDs

Every request carries one `x-request-id` from end to end:

| Hop | What happens |
| --- | --- |
| Browser → web | `apps/web/proxy.ts` keeps an incoming UUID or makes a new one, sets it on the request and echoes it on the response. |
| web → gateway | `gatewayFetch` and the route handlers forward it as `x-request-id`. |
| agent → MCP → gateway | `twokey-mcp` (HTTP) keeps an incoming UUID or makes one per request and forwards it; stdio mode makes one per tool call. |
| gateway | Uses the incoming value only if it is a UUID; otherwise it makes one. It returns it on every response, including errors (`error.requestId`). |
| PayPal webhook → gateway | A new request ID. The `webhook.applied` line also carries `originRequestId`: the ID of the proposal request that created the payment (stored on its `payment.created` event). |

Each gateway log line written while serving a request carries `requestId`, plus, once known,
`userIdHash` (sha256 of the user ID, first 12 hex characters), `sessionId`, `proposalId` and
`paymentId`. Job runs carry `paymentId`. Log lines never contain agent tokens, human
assertions, vault or payment-token IDs, or full webhook bodies (see
`packages/core/src/logger.ts` for the redaction list).

## Key log lines (gateway, info)

| `msg` | Fields | Meaning |
| --- | --- | --- |
| `decision.made` | `gate` (G4), `gateVersion`, `outcome` (capture, hold, block, ask_every_time), `blockedBy`, `mode`, `sessionId`, `proposalId`, `paymentId` | The gate decided a proposal. A block has `blockedBy` (the first failed rule) and no PayPal call follows. |
| `paypal.call` | `op` (method and templated path), `status` (0 = unreachable), `durationMs`, `debugId` | One PayPal REST call. Quote `debugId` to PayPal support. Failed calls log at warn with `issues`. |
| `webhook.applied` | `type`, `result` (applied, stale, no_payment, ignored), `lagSeconds`, `eventId`, `resourceId`, `paymentId`, `proposalId`, `originRequestId` | A verified webhook was processed. `retry: true` when the retry job applied it. |
| `job.done` | `queue`, `jobId`, `durationMs` | A pg-boss job finished (failures log `job failed` at error). |

## Find one purchase in the logs

**Locally.** `npm run e2e:purchase` prints `requestId=<uuid> product=<slug>` for each of its
three proposals and writes its gateway's log lines to `logs/e2e-purchase.log`. The dev
gateway (`npm run dev`) writes `logs/gateway.log`. Then:

```bash
grep <requestId> logs/*.log
```

That shows `decision.made`, each `paypal.call` (with its `debugId`) and, when PayPal
webhooks reach that gateway, `webhook.applied` (matched through `originRequestId`). Locally
`PUBLIC_BASE_URL` is localhost and no webhook is registered, so webhook lines appear only on
staging and production.

**On Render.** Render keeps each service's stdout as its log stream.

1. Get the request ID: from the response header `x-request-id`, the `requestId` in an error
   body, or a `decision.made` line found by `proposalId`.
2. Render dashboard → **gateway** service → **Logs** → search box → paste the ID. Render's
   search is a plain substring match over the JSON lines.
3. The same ID finds the web and MCP lines for that request (search those services too).
4. For the webhooks of that purchase, search the `paymentId` (or the `requestId`, which
   appears as `originRequestId`).

Free-plan logs are kept for a limited time (7 days at the time of writing). Copy what you need
into an issue before it ages out.

## Metrics

`GET /metrics` on the gateway, Prometheus text format, behind
`Authorization: Bearer $METRICS_TOKEN` (gateway env only; 401 without it, or when the variable
is not set).

| Metric | Type | Labels |
| --- | --- | --- |
| `twokey_decisions_total` | counter | `outcome` |
| `twokey_paypal_requests_total` | counter | `op`, `status` |
| `twokey_webhook_events_total` | counter | `type`, `verification` (SUCCESS, FAILURE) |
| `twokey_open_authorizations` | gauge, refreshed every 30 s | none |
| `twokey_webhook_lag_seconds` | histogram | none |

Counters reset when the gateway restarts (free services sleep after 15 minutes idle).

```bash
curl -s https://<gateway>/metrics -H "authorization: Bearer $METRICS_TOKEN" | grep twokey_
```

## Uptime monitoring (set up by a human)

Use a free external monitor (for example UptimeRobot, Better Stack or cron-job.org; any that
can check an HTTPS URL for a 200):

1. Create an HTTP(S) monitor for `https://<gateway>/healthz/deep`, every 5 minutes, alert
   when the status is not 200. The body names the failing part.
2. Create one for `https://<web>/api/healthz` (the web app is up).
3. Alert to the team's email. Free Render services sleep after 15 minutes idle, and a 5-minute
   check also keeps them awake. Mind the free plan's monthly instance hours (see DEPLOY.md).
4. Optional, with a monitor that supports keyword checks: `https://<gateway>/healthz/paypal`
   and alert when the body contains `"degraded":true`.

## What each alert means

| Alert | Likely cause | First step |
| --- | --- | --- |
| `/healthz/deep` 503, `db: fail` | Neon is down, asleep beyond the timeout, or `DATABASE_URL` / the role's password changed. | Neon console status; check the gateway's `DATABASE_URL`. |
| `/healthz/deep` 503, `paypalAuth` not ok | PayPal sandbox is down or the client credentials were rotated. | developer.paypal.com status; check `PAYPAL_CLIENT_ID` / `PAYPAL_CLIENT_SECRET`. |
| `/healthz/deep` 503, `webhookSubscriptions` not ok | The webhook was deleted or is missing event types. | `npm run paypal:webhook` (DEPLOY.md §3). |
| `/healthz/paypal` degraded: no webhook in 30 min while payments are pending | PayPal is not delivering, or the gateway rejects deliveries (bad `PAYPAL_WEBHOOK_ID`, verification failing). | Search logs for `paypal webhook failed verification` and `webhook verification unavailable`; the reconcile job keeps payments correct meanwhile. |
| Web `/api/healthz` down | Web build or start failed, or the service is sleeping and timed out. | Render events for the web service. |
| `twokey_open_authorizations` keeps rising | Holds are not being voided (job runner stopped) or captures are stuck. | Search `job failed` and `reconcile:` lines; the daily sweep voids holds past their deadline. |
| `twokey_paypal_requests_total{status="0"}` or 5xx rising | PayPal unreachable or erroring. | Check `paypal.call` lines with those statuses and their `debugId`. |
| `twokey_webhook_events_total{verification="FAILURE"}` rising | Someone is posting forged webhooks, or the webhook ID is wrong. | The rate limit caps deliveries at 600/min; check the source in logs. |
| `twokey_webhook_lag_seconds` high | PayPal is delivering late (normal during sandbox incidents). | None; reconcile covers state. |
