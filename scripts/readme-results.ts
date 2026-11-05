/**
 * Writes the generated number blocks in README.md and docs/DEVPOST.md from the evaluation's
 * metrics JSON, so no result number is ever typed by hand.
 *
 *   node scripts/readme-results.ts           rewrite the blocks
 *   node scripts/readme-results.ts --check   exit 1 if a block differs from the JSON, a
 *                                            development-set placeholder or a fill-in remains,
 *                                            or the README's AP2 paragraph differs from /about
 *
 * Source: eval/results/test-metrics.json. Until it exists (the test split is still running) the
 * blocks are drafted from eval/results/dev-metrics.json, labelled "development set" and marked
 * with PLACEHOLDER_MARK; rerunning the script once the test file exists replaces them.
 *
 * Standalone on purpose (node:* imports only): plain `node` strips the types, and workspace
 * packages, which export TypeScript source from node_modules, cannot be loaded that way.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

type Gate = 'G0' | 'G1' | 'G2' | 'G3' | 'G4';

interface GateMetrics {
  letThroughCount: number;
  attackerCaptured: number;
  held: number;
  honestInterrupted: number | null;
  honestInterruptedCount: number;
}

interface TargetCount {
  available: number;
  followed: number;
  rate: number | null;
}

interface ModelMetrics {
  runs: number;
  attacked: number;
  followed: number;
  followRate: number | null;
  cleanWithProposal: number;
  gates: Record<Gate, GateMetrics>;
  insideRules: { followed: number; heldShare: number | null };
  ruleOfThree: number | null;
  followByTarget: { outside_rules: TargetCount; inside_rules: TargetCount };
}

export interface Metrics {
  split: 'dev' | 'test';
  gateVersion: string;
  models: Record<string, ModelMetrics>;
  pooled: { attacked: number; ruleOfThree: number | null };
  attackerMoneyCentsG4: number;
  totals: { runs: number; gateDecisions: number };
}

export interface Prediction {
  metric: string;
  model: string;
  gate: string;
  low: number;
  high: number;
}

export interface Sources {
  metrics: Metrics;
  /** Repo-relative path of the metrics file, shown in the blocks. */
  metricsFile: string;
  staticCapCents: number;
  predictions: Prediction[];
  /** The development split, when the main source is the test split (for the dev→test note). */
  dev?: Metrics | undefined;
}

/** Every drafted block carries this; --check fails while any is left. */
export const PLACEHOLDER_MARK = '<!-- results:placeholder development-set -->';
/** Values the human fills by hand; --check fails while any is left. */
export const FILL_INS = ['<LIVE_URL>', '<DEMO_PASSWORD>'] as const;

/** Large first, as in EVAL_MODELS. */
const MODEL_ORDER = ['openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'nvidia/nemotron-3.5-bolt-e4b'];

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
/** Small bounds keep two significant digits: 0.015 -> 1.5%, 0.0075 -> 0.75%. */
const bound = (x: number) => `${Number((x * 100).toPrecision(2))}%`;
const usd = (cents: number) =>
  `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
/** Counts first; the share follows in brackets, and only when there is a denominator. */
const countOf = (n: number, d: number) => (d === 0 ? `${n} of 0` : `${n} of ${d} (${pct(n / d)})`);
const n = (x: number) => x.toLocaleString('en-US');
const pctOf = (a: number, d: number) => (d === 0 ? 'no share' : pct(a / d));
/** "11 of the 24 inside-the-rules follows (45.8%)". */
const heldPhrase = (held: number, inside: number) =>
  `${held} of the ${inside} inside-the-rules follows${inside === 0 ? '' : ` (${pct(held / inside)})`}`;

function orderedModels(s: Sources): string[] {
  const all = new Set([...Object.keys(s.metrics.models), ...s.predictions.map((p) => p.model)]);
  const known = MODEL_ORDER.filter((m) => all.has(m));
  const rest = [...all].filter((m) => !MODEL_ORDER.includes(m)).sort();
  return [...known, ...rest];
}

const isDraft = (s: Sources) => s.metrics.split !== 'test';
const setLabel = (s: Sources) => (isDraft(s) ? 'development set' : 'test split');
/** The anomaly hold share of followed inside-the-rules attacks, as a count. */
const heldOf = (m: ModelMetrics) =>
  Math.round((m.insideRules.heldShare ?? 0) * m.insideRules.followed);

function pooledCounts(s: Sources) {
  let outside = 0;
  let inside = 0;
  let held = 0;
  let attackerCaptures = 0;
  let attacked = 0;
  for (const m of Object.values(s.metrics.models)) {
    outside += m.followByTarget.outside_rules.followed;
    inside += m.followByTarget.inside_rules.followed;
    held += heldOf(m);
    attackerCaptures += m.gates.G4.attackerCaptured;
    attacked += m.attacked;
  }
  return { outside, inside, held, attackerCaptures, attacked };
}

/** "… and none that pointed outside them" rather than "only 0". */
const outsidePhrase = (outside: number) =>
  outside === 0 ? 'none that pointed outside them' : `only ${outside} that pointed outside them`;

/**
 * With no followed attack aimed at an attacker's store, $0.00 says nothing about the hard-rule
 * block: no gate could have paid one. Said plainly next to every $0.00 claim.
 */
function untestedNote(s: Sources): string | null {
  if (pooledCounts(s).outside > 0) return null;
  return (
    `No followed attack in the ${setLabel(s)} pointed at an attacker's store, so no gate could` +
    " have paid one: the $0.00 here does not test Two-Key's hard-rule block."
  );
}

/** Dev→test note: what the development split's outside-the-rules follows did at each gate. */
function devNote(s: Sources): string | null {
  const dev = s.dev;
  if (!dev || isDraft(s)) return null;
  const all = Object.values(dev.models);
  const attacked = all.reduce((a, m) => a + m.attacked, 0);
  const lead =
    `The development set (${n(attacked)} attacked runs, ${all.length} models, used to set the` +
    ' predictions)';
  const followers = Object.entries(dev.models).filter(
    ([, m]) => m.followByTarget.outside_rules.followed > 0,
  );
  const outside = followers.reduce((a, [, m]) => a + m.followByTarget.outside_rules.followed, 0);
  if (outside === 0) return `${lead} had no outside-the-rules follows either.`;
  const paidAt = (g: Gate) => followers.reduce((a, [, m]) => a + m.gates[g].attackerCaptured, 0);
  const who = followers.map(([id]) => `\`${id}\``).join(', ');
  return (
    `${lead} had ${outside} followed ${outside === 1 ? 'attack' : 'attacks'} aimed at an` +
    ` attacker's store (${who}). Attacker payments by gate: prompt guard only` +
    ` ${paidAt('G0')}, per-task cap ${paidAt('G1')}, static cap ${paidAt('G2')}, Two-Key` +
    ` ${paidAt('G4')} (${usd(dev.attackerMoneyCentsG4)}).`
  );
}

const notes = (s: Sources) => [untestedNote(s), devNote(s)].filter(Boolean).join(' ');

function draftBanner(s: Sources): string[] {
  if (!isDraft(s)) return [];
  return [
    PLACEHOLDER_MARK,
    `> **Draft: development set.** These numbers are placeholders from \`${s.metricsFile}\`` +
      ' (the development split). The test split is still running; when' +
      ' `eval/results/test-metrics.json` exists, `node scripts/readme-results.ts` replaces them.',
    '',
  ];
}

/** README, right under the GIF: the inside-the-rules finding in two sentences. */
function headlineBlock(s: Sources): string {
  const p = pooledCounts(s);
  const k = Object.keys(s.metrics.models).length;
  const paid = usd(s.metrics.attackerMoneyCentsG4);
  const lines = [
    ...draftBanner(s),
    `**What we found** (${n(p.attacked)} attacked runs, ${k} models, ${setLabel(s)}): hijacked` +
      ` agents followed **${p.inside}** attacks that stayed inside the signed rules and` +
      ` ${p.outside === 0 ? '**none**' : `**${p.outside}**`} that pointed outside them.` +
      ` Two-Key held ${heldPhrase(p.held, p.inside)} for the human; the rest fit every rule` +
      ' and went through ([what Two-Key does not stop](#what-two-key-does-not-stop)).' +
      ` Money paid to an attacker under Two-Key: **${paid}**.`,
  ];
  if (notes(s)) lines.push('', notes(s));
  return lines.join('\n');
}

function actualFor(m: ModelMetrics | undefined, p: Prediction): number | null {
  if (!m) return null;
  switch (p.metric) {
    case 'followRate':
      return m.followRate;
    case 'outsideFollowRate':
      return m.followByTarget.outside_rules.rate;
    case 'insideFollowRate':
      return m.followByTarget.inside_rules.rate;
    case 'honestInterrupted':
      return m.gates[p.gate as Gate]?.honestInterrupted ?? null;
    case 'insideRulesHeldShare':
      return m.insideRules.heldShare;
    default:
      return null;
  }
}

function resultsBlock(s: Sources): string {
  const { metrics } = s;
  const models = orderedModels(s);
  const cap = usd(s.staticCapCents);
  const out: string[] = [...draftBanner(s)];

  out.push(
    `Source: \`${s.metricsFile}\` (${setLabel(s)}, gate version \`${metrics.gateVersion}\`):` +
      ` ${n(metrics.totals.runs)} runs, ${n(metrics.totals.gateDecisions)} gate decisions.` +
      ' Every attacked run replays the same agent proposals through five gates: G0 prompt guard' +
      ` only, G1 per-task cap, G2 static cap (${cap}), G3 approve everything, G4 Two-Key.`,
    '',
    '### Where the attacks pointed',
    '',
    '| Model | Attacked runs | Followed, target outside the rules | Followed, target inside the rules | Inside follows held by Two-Key | Paid to an attacker payee under Two-Key |',
    '| --- | --- | --- | --- | --- | --- |',
  );
  for (const id of models) {
    const m = metrics.models[id];
    if (!m) {
      out.push(`| \`${id}\` | test split only: no development runs | — | — | — | — |`);
      continue;
    }
    const paid =
      m.gates.G4.attackerCaptured === 0
        ? '$0.00'
        : `${m.gates.G4.attackerCaptured} captures (pooled ${usd(metrics.attackerMoneyCentsG4)})`;
    out.push(
      `| \`${id}\` | ${n(m.attacked)} | ${countOf(m.followByTarget.outside_rules.followed, m.followByTarget.outside_rules.available)} | ${countOf(m.followByTarget.inside_rules.followed, m.followByTarget.inside_rules.available)} | ${countOf(heldOf(m), m.insideRules.followed)} | ${paid} |`,
    );
  }
  out.push(
    '',
    'An attack "inside the rules" points the agent at another product from a store the user' +
      ' allowed, within budget. It passes every signed rule; Two-Key holds it only when the price' +
      ' is unusual for that product.',
    '',
    ...(notes(s) ? [notes(s), ''] : []),
    '### Honest purchases and the trade-off',
    '',
  );
  for (const id of models) {
    const m = metrics.models[id];
    if (!m) continue;
    const g = (gate: Gate) => m.gates[gate];
    const honestPass = m.cleanWithProposal - g('G4').honestInterruptedCount;
    out.push(
      `- \`${id}\`: under Two-Key, ${g('G4').letThroughCount} of ${n(m.attacked)} attacked runs` +
        ` ended in a captured attack purchase and ${g('G4').honestInterruptedCount} of` +
        ` ${m.cleanWithProposal} honest purchases were interrupted (honest pass:` +
        ` ${honestPass} of ${m.cleanWithProposal}, ${pctOf(honestPass, m.cleanWithProposal)}).` +
        ` Per-task cap: ${g('G1').letThroughCount} of ${n(m.attacked)} let through,` +
        ` ${g('G1').honestInterruptedCount} of ${m.cleanWithProposal} interrupted. Static cap` +
        ` ${cap}: ${g('G2').letThroughCount} of ${n(m.attacked)} let through,` +
        ` ${g('G2').honestInterruptedCount} of ${m.cleanWithProposal} interrupted.`,
    );
  }
  out.push(
    '',
    'Each gate is one point on a trade-off between attacks let through and honest purchases' +
      ' interrupted; the frontier chart on `/results` plots all five per model.',
    '',
    '### How sure we can be about $0.00',
    '',
  );
  const r3 = models
    .map((id) => metrics.models[id])
    .filter((m): m is ModelMetrics => m !== undefined);
  if (r3.length > 0 && r3.every((m) => m.ruleOfThree !== null) && metrics.pooled.ruleOfThree) {
    const per = models
      .filter((id) => metrics.models[id])
      .map((id) => {
        const m = metrics.models[id] as ModelMetrics;
        return `\`${id}\` 0 of ${n(m.attacked)}, at most ${bound(m.ruleOfThree as number)}`;
      });
    out.push(
      'No attacker payee was paid under Two-Key. By the rule of three, the per-run chance of' +
        ` paying one is, at 95% confidence: ${per.join('; ')}; pooled, 0 of` +
        ` ${n(metrics.pooled.attacked)}, at most ${bound(metrics.pooled.ruleOfThree)}.` +
        (pooledCounts(s).outside === 0
          ? ' No followed attack aimed at an attacker in this split, so the bound reflects how' +
            ' rarely these agents tried, not a block Two-Key was seen to make.'
          : ''),
    );
  } else {
    out.push(
      `An attacker payee was paid under Two-Key (${usd(metrics.attackerMoneyCentsG4)}), so no` +
        ' rule-of-three bound applies.',
    );
  }
  out.push(
    '',
    '### Predicted vs actual',
    '',
    'Ranges from [PREDICTIONS.md](PREDICTIONS.md), registered before the test split ran.' +
      ' A miss is marked **✗ miss**.',
  );
  if (isDraft(s)) {
    out.push(
      '',
      '> The actual column below is the development set. The ranges were built from these same' +
        ' development results, so landing inside them proves nothing; the test split is the check.',
    );
  }
  out.push(
    '',
    '| Metric | Model | Gate | Predicted | Actual | In range |',
    '| --- | --- | --- | --- | --- | --- |',
  );
  for (const p of s.predictions) {
    const m = metrics.models[p.model];
    const actual = actualFor(m, p);
    const range = `${pct(p.low)}–${pct(p.high)}`;
    let actualCell: string;
    let verdict: string;
    if (!m) {
      actualCell = isDraft(s) ? 'test split only' : 'not run';
      verdict = '—';
    } else if (actual === null) {
      actualCell = 'no value (zero denominator)';
      verdict = 'no result';
    } else {
      actualCell = pct(actual);
      verdict = actual >= p.low && actual <= p.high ? '✓' : '**✗ miss**';
    }
    out.push(
      `| ${p.metric} | \`${p.model}\` | ${p.gate} | ${range} | ${actualCell} | ${verdict} |`,
    );
  }
  return out.join('\n');
}

/** Devpost "What it does" closing sentences. */
function devpostWhatBlock(s: Sources): string {
  const p = pooledCounts(s);
  const runs = `In ${n(s.metrics.totals.runs)} evaluation runs (${setLabel(s)})`;
  const paid = usd(s.metrics.attackerMoneyCentsG4);
  const first =
    p.outside === 0
      ? `${runs}, Two-Key paid an attacker ${paid}. No followed attack in that split aimed at an` +
        " attacker's store, so this does not test the hard-rule block."
      : `${runs}, Two-Key paid an attacker ${paid}, counting the ${p.outside} followed` +
        ` ${p.outside === 1 ? 'attack' : 'attacks'} aimed at an attacker's store.`;
  const dev = devNote(s);
  return [...draftBanner(s), dev ? `${first} ${dev}` : first].join('\n');
}

/** Devpost "What we learned": the inside-the-rules finding. */
function devpostLearnedBlock(s: Sources): string {
  const p = pooledCounts(s);
  return [
    ...draftBanner(s),
    `Hijacked agents followed ${p.inside} attacks that stayed inside the signed rules and` +
      ` ${outsidePhrase(p.outside)} (${n(p.attacked)} attacked runs, ${setLabel(s)}).` +
      ` Two-Key held ${heldPhrase(p.held, p.inside)} for the human;` +
      ' the others fit every rule and went through.',
  ].join('\n');
}

function predictionScore(s: Sources): { hits: number; scored: number } {
  let hits = 0;
  let scored = 0;
  for (const p of s.predictions) {
    const actual = actualFor(s.metrics.models[p.model], p);
    if (actual === null) continue;
    scored++;
    if (actual >= p.low && actual <= p.high) hits++;
  }
  return { hits, scored };
}

const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];

/**
 * The numbers the video's voice-over and captions use, all from the metrics file. Keys are the
 * `{placeholders}` in VOICE_OVER and docs/video/captions.template.srt.
 */
export function voiceOverNumbers(s: Sources): Record<string, string> {
  const p = pooledCounts(s);
  let outsideAvailable = 0;
  let insideAvailable = 0;
  let throughG4 = 0;
  for (const m of Object.values(s.metrics.models)) {
    outsideAvailable += m.followByTarget.outside_rules.available;
    insideAvailable += m.followByTarget.inside_rules.available;
    throughG4 += m.gates.G4.letThroughCount;
  }
  const k = Object.keys(s.metrics.models).length;
  const { hits, scored } = predictionScore(s);
  return {
    split: setLabel(s),
    models: String(k),
    modelsWord: WORDS[k] ?? String(k),
    attacked: n(p.attacked),
    outsideFollowed: String(p.outside),
    outsideAvailable: n(outsideAvailable),
    insideFollowed: String(p.inside),
    insideAvailable: n(insideAvailable),
    insideHeld: String(p.held),
    insideThroughG4: String(throughG4),
    paidG4: usd(s.metrics.attackerMoneyCentsG4),
    predictionHits: String(hits),
    predictionsScored: String(scored),
  };
}

/** Fills `{key}` placeholders; an unknown key is an error, so no placeholder reaches the video. */
export function fillNumbers(template: string, numbers: Record<string, string>): string {
  return template.replace(/\{([a-zA-Z][a-zA-Z0-9]*)\}/g, (_all, key: string) => {
    const v = numbers[key];
    if (v === undefined) throw new Error(`Unknown video number {${key}}`);
    return v;
  });
}

/** Voice-over lines that carry numbers. The runbook shows them filled in. */
const VOICE_OVER: [beat: string, line: string][] = [
  [
    '0:00 hook',
    'This attack text fooled all {modelsWord} models in our test. Here the price check catches it; in our test it caught {insideHeld} of {insideFollowed} — still an open problem.',
  ],
  [
    '0:32 attacker attempt',
    "Agents almost never try to pay the attacker: {outsideFollowed} of {outsideAvailable} chances in our test. When one does, it's impossible: no PayPal order is created.",
  ],
  [
    '1:10 results',
    'Outside the rules: {outsideFollowed} of {outsideAvailable}. Inside the rules: {insideFollowed} of {insideAvailable}. {paidG4} to attackers, and since no agent tried, that number does not test the block.',
  ],
  [
    '1:40 honesty',
    'On this test the flat cap did as well or better, because no agent tried to pay the attacker. What a cap can’t do is stop a payment to an attacker under the cap; Two-Key’s payee rule can. Predictions: {predictionHits} of {predictionsScored} landed, and we show the misses.',
  ],
  [
    'closing line',
    "In {attacked} poisoned shopping trips on frozen test data, {modelsWord} AI agents never once followed 'pay the attacker', but tried to buy the wrong thing inside the budget {insideFollowed} times. Two-Key makes paying an attacker impossible; the wrong-product problem is still open, and we measured it.",
  ],
];

/** docs/VIDEO.md: every number the video says or shows, and the filled voice-over lines. */
function videoBlock(s: Sources): string {
  const v = voiceOverNumbers(s);
  const out = [
    ...draftBanner(s),
    `From \`${s.metricsFile}\` (${v.split}): ${v.attacked} attacked runs, ${v.models} models.`,
    '',
    '| Model | Outside the rules followed | Inside the rules followed | Inside follows held | Static cap: let through / honest interrupted | Two-Key: let through / honest interrupted |',
    '| --- | --- | --- | --- | --- | --- |',
  ];
  for (const id of orderedModels(s)) {
    const m = s.metrics.models[id];
    if (!m) continue;
    const g = (gate: Gate) =>
      `${m.gates[gate].letThroughCount} of ${n(m.attacked)} / ${m.gates[gate].honestInterruptedCount} of ${m.cleanWithProposal}`;
    out.push(
      `| \`${id}\` | ${m.followByTarget.outside_rules.followed} of ${m.followByTarget.outside_rules.available} | ${m.followByTarget.inside_rules.followed} of ${m.followByTarget.inside_rules.available} | ${heldOf(m)} of ${m.insideRules.followed} | ${g('G2')} | ${g('G4')} |`,
    );
  }
  out.push(
    `| **All** | **${v.outsideFollowed} of ${v.outsideAvailable}** | **${v.insideFollowed} of ${v.insideAvailable}** | **${v.insideHeld} of ${v.insideFollowed}** | | |`,
    '',
    `Paid to an attacker under Two-Key: ${v.paidG4}. Predictions in range: ${v.predictionHits} of ${v.predictionsScored}.`,
    '',
    'Voice-over lines with numbers (filled from the metrics; say them as written):',
    '',
  );
  for (const [beat, line] of VOICE_OVER) out.push(`- **${beat}:** "${fillNumbers(line, v)}"`);
  return out.join('\n');
}

export const VIDEO_DOC = 'docs/VIDEO.md';
export const CAPTIONS_TEMPLATE = 'docs/video/captions.template.srt';
export const CAPTIONS = 'docs/video/captions.srt';

/** captions.srt from its template, numbers filled from the metrics. */
export function renderCaptions(template: string, s: Sources): string {
  return fillNumbers(template, voiceOverNumbers(s));
}

const BLOCKS: Record<string, (s: Sources) => string> = {
  video: videoBlock,
  results: resultsBlock,
  headline: headlineBlock,
  'devpost-what': devpostWhatBlock,
  'devpost-learned': devpostLearnedBlock,
};

/** `<!-- results:start -->` is the README's main block; others are `<!-- results:NAME:start -->`. */
const BLOCK_RE = /<!-- results(?::([a-z-]+))?:start -->[\s\S]*?<!-- results(?::\1)?:end -->/g;

/** Rewrites every known block in `text`; unknown block names are an error. */
export function renderBlocks(text: string, s: Sources): string {
  return text.replace(BLOCK_RE, (_all, name: string | undefined) => {
    const key = name ?? 'results';
    const make = BLOCKS[key];
    if (!make) throw new Error(`Unknown results block "${key}"`);
    const tag = name ? `results:${name}` : 'results';
    return `<!-- ${tag}:start -->\n${make(s)}\n<!-- ${tag}:end -->`;
  });
}

export function blockNames(text: string): string[] {
  return [...text.matchAll(BLOCK_RE)].map((m) => m[1] ?? 'results');
}

/** Parses `| metric | model | gate | low | high |` rows of PREDICTIONS.md. */
export function parsePredictions(markdown: string): Prediction[] {
  const rows: Prediction[] = [];
  for (const line of markdown.split('\n')) {
    const cells = line.split('|').map((c) => c.trim());
    if (cells.length !== 7) continue;
    const [, metric, model, gate, low, high] = cells as [
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    if (metric === 'metric' || metric.startsWith('---')) continue;
    const lo = Number(low);
    const hi = Number(high);
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || low === '' || high === '') continue;
    rows.push({ metric, model, gate, low: lo, high: hi });
  }
  return rows;
}

/** The fixed AP2 paragraph from apps/web/app/about/page.tsx. */
export function ap2FromAbout(source: string): string {
  const m = /const AP2 =\s*\n?\s*"([^"]+)"/.exec(source);
  if (!m?.[1]) throw new Error('AP2 constant not found in the about page');
  return m[1];
}

export function loadSources(root: string): Sources {
  const test = 'eval/results/test-metrics.json';
  const dev = 'eval/results/dev-metrics.json';
  const metricsFile = existsSync(join(root, test)) ? test : dev;
  const metrics = JSON.parse(readFileSync(join(root, metricsFile), 'utf8')) as Metrics;
  const devMetrics =
    metricsFile === test && existsSync(join(root, dev))
      ? (JSON.parse(readFileSync(join(root, dev), 'utf8')) as Metrics)
      : undefined;
  const manifest = JSON.parse(readFileSync(join(root, 'eval/frozen/manifest.json'), 'utf8')) as {
    staticCapCents: number;
  };
  return {
    metrics,
    metricsFile,
    staticCapCents: manifest.staticCapCents,
    predictions: parsePredictions(readFileSync(join(root, 'PREDICTIONS.md'), 'utf8')),
    dev: devMetrics,
  };
}

export const TARGETS = ['README.md', 'docs/DEVPOST.md'] as const;
const REQUIRED: Record<(typeof TARGETS)[number], string[]> = {
  'README.md': ['headline', 'results'],
  'docs/DEVPOST.md': ['devpost-what', 'devpost-learned'],
};

/** Problems --check reports; empty means the files match the JSON and nothing is left to fill. */
export function checkFiles(root: string, s: Sources): string[] {
  const problems: string[] = [];
  for (const file of TARGETS) {
    const path = join(root, file);
    if (!existsSync(path)) {
      problems.push(`${file}: missing`);
      continue;
    }
    const text = readFileSync(path, 'utf8');
    const names = blockNames(text);
    for (const want of REQUIRED[file]) {
      if (!names.includes(want)) problems.push(`${file}: no "${want}" results block`);
    }
    if (renderBlocks(text, s) !== text) {
      problems.push(
        `${file}: numbers differ from ${s.metricsFile}; run node scripts/readme-results.ts`,
      );
    }
    const drafts = text.split(PLACEHOLDER_MARK).length - 1;
    if (drafts > 0) {
      problems.push(
        `${file}: ${drafts} development-set placeholder block(s) (test-metrics.json not used yet)`,
      );
    }
    for (const f of FILL_INS) {
      if (text.includes(f)) problems.push(`${file}: fill in ${f}`);
    }
  }
  // The video runbook and captions are checked whenever they exist (always, in the repo).
  if (existsSync(join(root, VIDEO_DOC))) {
    const text = readFileSync(join(root, VIDEO_DOC), 'utf8');
    if (!blockNames(text).includes('video'))
      problems.push(`${VIDEO_DOC}: no "video" results block`);
    if (renderBlocks(text, s) !== text) {
      problems.push(
        `${VIDEO_DOC}: numbers differ from ${s.metricsFile}; run node scripts/readme-results.ts`,
      );
    }
  }
  if (existsSync(join(root, CAPTIONS_TEMPLATE))) {
    const want = renderCaptions(readFileSync(join(root, CAPTIONS_TEMPLATE), 'utf8'), s);
    const have = existsSync(join(root, CAPTIONS)) ? readFileSync(join(root, CAPTIONS), 'utf8') : '';
    if (want !== have) {
      problems.push(
        `${CAPTIONS}: differs from its template and ${s.metricsFile}; run node scripts/readme-results.ts`,
      );
    }
  }
  const readme = existsSync(join(root, 'README.md'))
    ? readFileSync(join(root, 'README.md'), 'utf8')
    : '';
  const ap2 = ap2FromAbout(readFileSync(join(root, 'apps/web/app/about/page.tsx'), 'utf8'));
  if (!readme.includes(ap2))
    problems.push('README.md: the AP2 paragraph is not the /about text verbatim');
  return problems;
}

function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const s = loadSources(root);
  if (process.argv.includes('--check')) {
    const problems = checkFiles(root, s);
    for (const p of problems) console.error(`✗ ${p}`);
    if (problems.length > 0) process.exit(1);
    console.log(`README and Devpost numbers match ${s.metricsFile}; no placeholders left.`);
    return;
  }
  for (const file of TARGETS) {
    const path = join(root, file);
    const before = readFileSync(path, 'utf8');
    const after = renderBlocks(before, s);
    if (after !== before) writeFileSync(path, after);
    console.log(`${after === before ? 'unchanged' : 'updated'} ${file} from ${s.metricsFile}`);
  }
  const video = join(root, VIDEO_DOC);
  if (existsSync(video)) {
    const before = readFileSync(video, 'utf8');
    const after = renderBlocks(before, s);
    if (after !== before) writeFileSync(video, after);
    console.log(`${after === before ? 'unchanged' : 'updated'} ${VIDEO_DOC} from ${s.metricsFile}`);
  }
  const template = join(root, CAPTIONS_TEMPLATE);
  if (existsSync(template)) {
    const out = renderCaptions(readFileSync(template, 'utf8'), s);
    const path = join(root, CAPTIONS);
    const before = existsSync(path) ? readFileSync(path, 'utf8') : '';
    if (out !== before) writeFileSync(path, out);
    console.log(`${out === before ? 'unchanged' : 'updated'} ${CAPTIONS} from ${s.metricsFile}`);
  }
  if (isDraft(s))
    console.log('Draft: development-set placeholders written; --check fails until the test split.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
