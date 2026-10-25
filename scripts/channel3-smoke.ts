/**
 * R19: what does Channel3 actually return? Searches "running shoes" (limit 3) and prints the shape.
 * Needs CHANNEL3_API_KEY in .env.gateway. Appends the finding to docs/SPIKE_RESULTS.md.
 */
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Channel3 } from '@channel3/sdk';

const apiKey = process.env.CHANNEL3_API_KEY;
if (!apiKey) {
  console.error('Set CHANNEL3_API_KEY in .env.gateway');
  process.exit(1);
}

const client = new Channel3({ apiKey });
const page = await client.products.search({ query: 'running shoes', limit: 3 });
const products = page.data;
const first = products[0];
if (!first) {
  console.error('Channel3 returned no products');
  process.exit(1);
}

const keys = Object.keys(first);
console.log(`product keys: ${keys.join(', ')}`);
const lines: string[] = [];
for (const p of products) {
  for (const o of p.offers ?? []) {
    const line = `${p.id} | ${o.domain} | ${o.price.price} ${o.price.currency} | ${o.availability}`;
    lines.push(line);
    console.log(`offer: ${line}`);
  }
}
const attrs = Object.keys(first.structured_attributes ?? {});
const variantNames = first.variants?.options.map((o) => o.name) ?? [];
const hasSize = [...attrs, ...variantNames].some((n) => /size/i.test(n));
console.log(`structured attributes: ${attrs.join(', ') || '(none)'}`);
console.log(`variant options: ${variantNames.join(', ') || '(none)'}`);
console.log(`structured size: ${hasSize ? 'yes' : 'no'}`);

const doc = fileURLToPath(new URL('../docs/SPIKE_RESULTS.md', import.meta.url));
appendFileSync(
  doc,
  [
    '',
    `## R19 Channel3 structured attributes — ${new Date().toISOString()}`,
    '',
    `- Product keys: ${keys.join(', ')}`,
    `- structured_attributes keys: ${attrs.join(', ') || '(none)'}; variant options: ${variantNames.join(', ') || '(none)'}`,
    `- **Structured size: ${hasSize ? 'yes' : 'no'}**`,
    '- Offers:',
    ...lines.map((l) => `  - ${l}`),
    '',
  ].join('\n'),
);
