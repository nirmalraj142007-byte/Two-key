/**
 * Phase 2 check against PayPal's own records: re-reads orders A–D of the last GO vault-spike
 * run from PayPal and compares them with what the spike claimed.
 *
 *   npm run spike:verify
 */
import { readFileSync } from 'node:fs';
import {
  appendSpikeResults,
  describeError,
  readMerchants,
  readResult,
  SPIKE_RESULTS_MD,
  setupPayPal,
} from './lib.js';

interface Row {
  order: string;
  status: string;
  amount: string;
  payee: string;
  expected: string;
  match: boolean;
}

function at(v: unknown, ...path: (string | number)[]): unknown {
  let cur = v;
  for (const key of path) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string | number, unknown>)[key];
  }
  return cur;
}

const text = (v: unknown) => (typeof v === 'string' ? v : '');
const money = (m: unknown) =>
  text(at(m, 'value')) ? `${text(at(m, 'value'))} ${text(at(m, 'currency_code'))}` : '-';

/** IDs from the last GO section of docs/SPIKE_RESULTS.md, plus honor.json for order D. */
function readIds() {
  const sections = readFileSync(SPIKE_RESULTS_MD, 'utf8').split(/^## /m);
  const go = sections.filter((s) => s.startsWith('Vault spike') && s.includes('**GO**')).at(-1);
  if (!go) throw new Error('No GO vault-spike run in docs/SPIKE_RESULTS.md');
  const pick = (re: RegExp) => {
    const m = go.match(re);
    if (!m?.[1]) throw new Error(`Could not find ${re} in the last GO run`);
    return m[1];
  };
  const honor = readResult<{ authorizationId: string }>('honor.json');
  if (!honor?.authorizationId) throw new Error('spikes/results/honor.json is missing');
  return {
    run: pick(/^Vault spike — \S+ \(run `([^`]+)`/),
    aOrder: pick(/\| d \| OK \| order A (\w+)/),
    aCapture: pick(/\| d \| OK \| capture (\w+)/),
    bAuthorization: pick(/\| e \| OK \| order B \w+ \w+; authorization (\w+)/),
    cOrder: pick(/\| f \| OK \| order C (\w+)/),
    cCapture: pick(/\| f \| OK \| capture (\w+)/),
    dAuthorization: honor.authorizationId,
  };
}

const ONE_DOLLAR = '1.00 USD';
const pp = setupPayPal();
const merchants = readMerchants();
const registryIds = new Set(merchants.map((m) => m.paypalMerchantId));
const stride = merchants.find((m) => m.slug === 'stride-supply');
const ids = readIds();
const rows: Row[] = [];
const notes: string[] = [];

console.log(`PayPal-side verification of vault-spike run ${ids.run}`);

async function check(order: string, fn: () => Promise<Row>): Promise<void> {
  try {
    rows.push(await fn());
  } catch (err) {
    rows.push({
      order,
      status: `ERROR ${describeError(err)}`,
      amount: '-',
      payee: '-',
      expected: '-',
      match: false,
    });
  }
}

await check('A', async () => {
  const order = await pp.getOrder(ids.aOrder);
  const cap = await pp.getCapture(ids.aCapture);
  const payee = text(at(order.raw, 'purchase_units', 0, 'payee', 'merchant_id'));
  const amount = money(at(cap.raw, 'amount'));
  notes.push(`A: order ${ids.aOrder}, capture ${ids.aCapture}`);
  return {
    order: 'A',
    status: `order ${order.status} / capture ${cap.status}`,
    amount,
    payee: payee || '-',
    expected: `order COMPLETED / capture COMPLETED, ${ONE_DOLLAR}, platform payee (not a registry merchant)`,
    match:
      order.status === 'COMPLETED' &&
      cap.status === 'COMPLETED' &&
      amount === ONE_DOLLAR &&
      payee !== '' &&
      !registryIds.has(payee),
  };
});

await check('B', async () => {
  const auth = await pp.getAuthorization(ids.bAuthorization);
  const amount = money(at(auth.raw, 'amount'));
  notes.push(`B: authorization ${ids.bAuthorization}`);
  return {
    order: 'B',
    status: `authorization ${auth.status}`,
    amount,
    payee: text(at(auth.raw, 'payee', 'merchant_id')) || '-',
    expected: `authorization VOIDED, ${ONE_DOLLAR}`,
    match: auth.status === 'VOIDED' && amount === ONE_DOLLAR,
  };
});

await check('C', async () => {
  const cap = await pp.getCapture(ids.cCapture);
  let payee = text(at(cap.raw, 'payee', 'merchant_id'));
  if (!payee) {
    const order = await pp.getOrder(ids.cOrder);
    payee = text(at(order.raw, 'purchase_units', 0, 'payee', 'merchant_id'));
    notes.push('C: capture has no payee field; payee read from the order');
  }
  const amount = money(at(cap.raw, 'amount'));
  const net = money(at(cap.raw, 'seller_receivable_breakdown', 'net_amount'));
  const fee = money(at(cap.raw, 'seller_receivable_breakdown', 'paypal_fee'));
  notes.push(`C: capture ${ids.cCapture}; seller net_amount ${net} (paypal_fee ${fee})`);
  const expectedPayee = stride?.paypalMerchantId ?? '(stride-supply missing)';
  return {
    order: 'C',
    status: `capture ${cap.status}`,
    amount,
    payee: payee || '-',
    expected: `capture COMPLETED, ${ONE_DOLLAR}, ${expectedPayee} (Stride Supply)`,
    match: cap.status === 'COMPLETED' && amount === ONE_DOLLAR && payee === expectedPayee,
  };
});

await check('D', async () => {
  const auth = await pp.getAuthorization(ids.dAuthorization);
  const amount = money(at(auth.raw, 'amount'));
  const expires = auth.expirationTime ?? '';
  notes.push(`D: authorization ${ids.dAuthorization}; expiration_time ${expires || '-'}`);
  return {
    order: 'D',
    status: `authorization ${auth.status}`,
    amount,
    payee: text(at(auth.raw, 'payee', 'merchant_id')) || '-',
    expected: `authorization CREATED, ${ONE_DOLLAR}, expiration in the future`,
    match:
      auth.status === 'CREATED' &&
      amount === ONE_DOLLAR &&
      expires !== '' &&
      Date.parse(expires) > Date.now(),
  };
});

const header = ['order', 'PayPal status', 'amount', 'payee merchant_id', 'expected', 'result'];
const cells = rows.map((r) => [
  r.order,
  r.status,
  r.amount,
  r.payee,
  r.expected,
  r.match ? 'MATCH' : 'MISMATCH',
]);
const widths = header.map((h, i) => Math.max(h.length, ...cells.map((c) => (c[i] ?? '').length)));
const fmt = (c: string[]) => c.map((v, i) => v.padEnd(widths[i] ?? 0)).join(' | ');

console.log('');
console.log(fmt(header));
console.log(widths.map((w) => '-'.repeat(w)).join('-|-'));
for (const c of cells) console.log(fmt(c));
console.log('');
for (const n of notes) console.log(n);

const allMatch = rows.length === 4 && rows.every((r) => r.match);
const verdict = allMatch ? 'ALL MATCH' : 'MISMATCH';
console.log('');
console.log(verdict);

const now = new Date();
appendSpikeResults(
  [
    `## PayPal-side verification ${now.toISOString().slice(0, 10)}`,
    '',
    `Read back from PayPal at ${now.toISOString()} for vault-spike run \`${ids.run}\` (\`npm run spike:verify\`).`,
    '',
    `| ${header.join(' | ')} |`,
    `| ${header.map(() => '---').join(' | ')} |`,
    ...cells.map((c) => `| ${c.map((v) => v.replaceAll('|', '\\|')).join(' | ')} |`),
    '',
    ...notes.map((n) => `- ${n}`),
    `- **${verdict}**`,
  ].join('\n'),
);
console.log('Appended to docs/SPIKE_RESULTS.md');

process.exitCode = allMatch ? 0 : 1;
