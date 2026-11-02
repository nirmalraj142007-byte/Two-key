import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ap2FromAbout,
  checkFiles,
  loadSources,
  type Metrics,
  PLACEHOLDER_MARK,
  parsePredictions,
  renderBlocks,
} from '../readme-results.js';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p: string) => readFileSync(join(repo, p), 'utf8');
const devMetrics = JSON.parse(read('eval/results/dev-metrics.json')) as Metrics;

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

/** A copy of the files the script reads and writes, with the fill-ins filled. */
function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'readme-results-'));
  roots.push(root);
  for (const p of [
    'README.md',
    'docs/DEVPOST.md',
    'PREDICTIONS.md',
    'eval/results/dev-metrics.json',
    'eval/frozen/manifest.json',
    'apps/web/app/about/page.tsx',
  ]) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    cpSync(join(repo, p), join(root, p));
  }
  for (const p of ['README.md', 'docs/DEVPOST.md']) {
    const text = readFileSync(join(root, p), 'utf8').replace(/<[A-Z_]+>/g, 'filled');
    writeFileSync(join(root, p), text);
  }
  return root;
}

/** The dev numbers relabelled as the test split (for the switch-over path only). */
function writeTestMetrics(root: string, edit: (m: Metrics) => void = () => {}) {
  const m = structuredClone(devMetrics);
  m.split = 'test';
  edit(m);
  writeFileSync(join(root, 'eval/results/test-metrics.json'), JSON.stringify(m));
}

function regenerate(root: string) {
  const s = loadSources(root);
  for (const p of ['README.md', 'docs/DEVPOST.md']) {
    writeFileSync(join(root, p), renderBlocks(readFileSync(join(root, p), 'utf8'), s));
  }
}

describe('readme-results', () => {
  it('drafts from the dev file with a development-set placeholder, and --check fails', () => {
    const root = fixtureRoot();
    regenerate(root);
    const readme = readFileSync(join(root, 'README.md'), 'utf8');
    expect(readme).toContain(PLACEHOLDER_MARK);
    expect(readme).toContain('development set');
    const problems = checkFiles(root, loadSources(root));
    expect(problems.some((p) => p.includes('development-set placeholder'))).toBe(true);
  });

  it('replaces the placeholders once test-metrics.json exists, and --check passes', () => {
    const root = fixtureRoot();
    regenerate(root);
    writeTestMetrics(root);
    expect(checkFiles(root, loadSources(root)).some((p) => p.includes('differ'))).toBe(true);
    regenerate(root);
    const readme = readFileSync(join(root, 'README.md'), 'utf8');
    expect(readme).not.toContain(PLACEHOLDER_MARK);
    expect(readme).toContain('eval/results/test-metrics.json');
    expect(checkFiles(root, loadSources(root))).toEqual([]);
  });

  it('fails --check when a README number is edited by hand', () => {
    const root = fixtureRoot();
    writeTestMetrics(root);
    regenerate(root);
    const path = join(root, 'README.md');
    writeFileSync(path, readFileSync(path, 'utf8').replace('11 of 82', '9 of 82'));
    expect(checkFiles(root, loadSources(root))).toEqual([
      'README.md: numbers differ from eval/results/test-metrics.json; run node scripts/readme-results.ts',
    ]);
  });

  it('leads with counts and marks a prediction miss', () => {
    const root = fixtureRoot();
    writeTestMetrics(root, (m) => {
      const model = m.models['openai/gpt-oss-20b'];
      if (model) model.followRate = 0.5;
    });
    regenerate(root);
    const readme = readFileSync(join(root, 'README.md'), 'utf8');
    expect(readme).toContain(
      '| followRate | `openai/gpt-oss-20b` | — | 3.0%–11.0% | 50.0% | **✗ miss** |',
    );
    expect(readme).toContain('11 of 82 (13.4%)');
    expect(readme).toContain('Static cap $120.00');
  });

  it('fails --check when the AP2 paragraph drifts from /about', () => {
    const root = fixtureRoot();
    writeTestMetrics(root);
    regenerate(root);
    const path = join(root, 'README.md');
    writeFileSync(path, readFileSync(path, 'utf8').replace('Intent Mandate.', 'mandate.'));
    expect(checkFiles(root, loadSources(root))).toContain(
      'README.md: the AP2 paragraph is not the /about text verbatim',
    );
  });

  it('reads all 21 registered predictions and the AP2 constant', () => {
    expect(parsePredictions(read('PREDICTIONS.md'))).toHaveLength(21);
    expect(ap2FromAbout(read('apps/web/app/about/page.tsx'))).toMatch(/^Google's Agent Payments/);
  });
});
