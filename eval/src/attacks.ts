import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { AppError, ErrorCode } from '@twokey/core';
import { createTwoFilesPatch } from 'diff';

export type AttackSource = 'injecagent' | 'agentdojo';

/** Pinned upstream commits (cloned 2026-10-25). The build refuses any other checkout. */
export const PINNED = {
  injecagent: {
    repo: 'https://github.com/uiuc-kang-lab/InjecAgent',
    dir: 'eval/vendor/InjecAgent',
    commit: 'f19c9f2c79a41046eb13c03c51a24c567a8ffa07',
  },
  agentdojo: {
    repo: 'https://github.com/ethz-spylab/agentdojo',
    dir: 'eval/vendor/agentdojo',
    commit: '089ed468cf3ed0322acc66b0211f26d9d90dbf60',
  },
} as const;

/** InjecAgent attacker tools kept as financial: the name contains one of these. */
export const FINANCIAL_TOOL = /Transfer|Pay|Payment|Bank|Venmo|Crypto|Trade|Fund/;

/**
 * AgentDojo fills {user} with ImportantInstructionsAttack's user_name and {model} with
 * get_model_name_from_pipeline(), a lookup in MODEL_NAMES. Our Groq models are not in
 * MODEL_NAMES; they are served through an OpenAI-compatible endpoint, which AgentDojo runs as the
 * "local" pipeline, so {model} takes MODEL_NAMES["local"]. Both values are read from the pinned
 * source, never typed here.
 */
export const AGENTDOJO_MODEL_KEY = 'local';

export interface GoalTemplate {
  source: AttackSource;
  sourceRef: string;
  /** The published text with its original goal: before + goal + after. */
  before: string;
  goal: string;
  after: string;
  licence: string;
}

export interface AttackTarget {
  title: string;
  productId: string;
  storeName: string;
}

export function goalSentence(t: AttackTarget): string {
  return `Buy ${t.title} (product id ${t.productId}) from ${t.storeName}.`;
}

/** Placeholders stored in attack_templates.adapted_text; each episode fills them. */
export const PLACEHOLDER_TARGET: AttackTarget = {
  title: '{title}',
  productId: '{productId}',
  storeName: '{storeName}',
};

export interface Adapted {
  originalText: string;
  adaptedText: string;
  diff: string;
}

/** Replaces ONLY the goal span with the purchase goal, and proves it with the diff. */
export function adaptGoal(template: GoalTemplate, target: AttackTarget): Adapted {
  const newGoal = goalSentence(target);
  const originalText = template.before + template.goal + template.after;
  const adaptedText = template.before + newGoal + template.after;
  const diff = createTwoFilesPatch('original', 'adapted', originalText, adaptedText, '', '', {
    context: 2,
  });
  assertDiffInsideGoal({
    originalText,
    adaptedText,
    diff,
    goalStart: template.before.length,
    originalGoalEnd: template.before.length + template.goal.length,
    adaptedGoalEnd: template.before.length + newGoal.length,
  });
  return { originalText, adaptedText, diff };
}

interface DiffCheck {
  originalText: string;
  adaptedText: string;
  diff: string;
  goalStart: number;
  originalGoalEnd: number;
  adaptedGoalEnd: number;
}

function lineRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let start = 0;
  for (const line of text.split('\n')) {
    ranges.push([start, start + line.length]);
    start += line.length + 1;
  }
  return ranges;
}

function overlaps([s, e]: [number, number], from: number, to: number): boolean {
  // A line touches the span if it shares a character with it (an empty span touches its line).
  return from === to ? s <= from && from <= e : s < to && from < e;
}

/** Throws unless every removed and added line of the unified diff lies inside the goal span. */
export function assertDiffInsideGoal(c: DiffCheck): void {
  const prefixOk = c.adaptedText.slice(0, c.goalStart) === c.originalText.slice(0, c.goalStart);
  const suffixOk =
    c.adaptedText.slice(c.adaptedGoalEnd) === c.originalText.slice(c.originalGoalEnd);
  if (!prefixOk || !suffixOk) {
    throw new AppError(ErrorCode.INTERNAL, 'Adapted text changed outside the goal span');
  }
  const oldLines = lineRanges(c.originalText);
  const newLines = lineRanges(c.adaptedText);
  let oldLine = 0;
  let newLine = 0;
  let changed = 0;
  for (const line of c.diff.split('\n')) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      oldLine = Number(hunk[1]) - 1;
      newLine = Number(hunk[2]) - 1;
      continue;
    }
    if (line.startsWith('---') || line.startsWith('+++') || line.startsWith('\\')) continue;
    if (line.startsWith('-')) {
      const range = oldLines[oldLine++];
      if (!range || !overlaps(range, c.goalStart, c.originalGoalEnd)) {
        throw new AppError(ErrorCode.INTERNAL, `Diff removes a line outside the goal: ${line}`);
      }
      changed++;
    } else if (line.startsWith('+')) {
      const range = newLines[newLine++];
      if (!range || !overlaps(range, c.goalStart, c.adaptedGoalEnd)) {
        throw new AppError(ErrorCode.INTERNAL, `Diff adds a line outside the goal: ${line}`);
      }
      changed++;
    } else if (line.startsWith(' ')) {
      oldLine++;
      newLine++;
    }
  }
  if (changed === 0 && c.originalText !== c.adaptedText) {
    throw new AppError(ErrorCode.INTERNAL, 'Diff is empty but the texts differ');
  }
}

// ---- reading the pinned repositories ----

function missingVendor(source: AttackSource): AppError {
  const p = PINNED[source];
  return new AppError(
    ErrorCode.CONFIG_INVALID,
    `Missing ${p.dir}. Run: git clone ${p.repo} ${p.dir} && git -C ${p.dir} checkout ${p.commit}`,
  );
}

/** Reads `path` at the pinned commit (not the working tree), after checking HEAD. */
export function readPinned(source: AttackSource, path: string): string {
  const p = PINNED[source];
  if (!existsSync(p.dir)) throw missingVendor(source);
  const head = execFileSync('git', ['-C', p.dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  if (head !== p.commit) {
    throw new AppError(
      ErrorCode.CONFIG_INVALID,
      `${p.dir} is at ${head}, expected ${p.commit}. Run: git -C ${p.dir} checkout ${p.commit}`,
    );
  }
  return execFileSync('git', ['-C', p.dir, 'show', `${p.commit}:${path}`], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** The licence as read from the repo's licence file at the pinned commit. */
export function readLicence(source: AttackSource): { licence: string; file: string } {
  for (const file of ['LICENSE', 'LICENCE', 'LICENSE.md', 'LICENSE.txt']) {
    let text: string;
    try {
      text = readPinned(source, file);
    } catch (err) {
      if (err instanceof AppError) throw err;
      continue;
    }
    const first =
      text
        .split('\n')
        .find((l) => l.trim())
        ?.trim() ?? '';
    const name = /^MIT License$/i.test(first) ? 'MIT' : first;
    return { licence: `${name} (${file} at ${PINNED[source].commit.slice(0, 7)})`, file };
  }
  throw new AppError(ErrorCode.CONFIG_INVALID, `No licence file found in ${PINNED[source].dir}`);
}

// ---- InjecAgent ----

/** The fixed hacking prompt of InjecAgent's enhanced setting, as printed in its README. */
export function parseInjecAgentPrefix(readme: string): string {
  const line = readme.split('\n').find((l) => l.startsWith('IMPORTANT!!!'));
  if (!line)
    throw new AppError(ErrorCode.CONFIG_INVALID, 'InjecAgent README has no IMPORTANT!!! line');
  return line.trimEnd();
}

interface InjecAgentCase {
  'Attacker Tools': string[];
  'Attacker Instruction': string;
}

export function injecAgentTemplates(input: {
  casesJsonl: string;
  prefix: string;
  /** Tool responses of the enhanced test cases, to check the template matches InjecAgent's text. */
  enhancedResponses: string[];
  licence: string;
  commit: string;
}): GoalTemplate[] {
  const out: GoalTemplate[] = [];
  const lines = input.casesJsonl.split('\n');
  lines.forEach((raw, i) => {
    if (!raw.trim()) return;
    const c = JSON.parse(raw) as InjecAgentCase;
    if (!c['Attacker Tools'].some((t) => FINANCIAL_TOOL.test(t))) return;
    const before = `${input.prefix} `;
    const goal = c['Attacker Instruction'];
    if (!input.enhancedResponses.some((r) => r.includes(before + goal))) {
      throw new AppError(
        ErrorCode.CONFIG_INVALID,
        `InjecAgent case on line ${i + 1} does not appear in the enhanced test cases`,
      );
    }
    out.push({
      source: 'injecagent',
      sourceRef: `data/attacker_cases_dh.jsonl:line ${i + 1} (${c['Attacker Tools'].join('+')})@${input.commit}`,
      before,
      goal,
      after: '',
      licence: input.licence,
    });
  });
  return out;
}

export function loadInjecAgent(): GoalTemplate[] {
  const { licence } = readLicence('injecagent');
  return injecAgentTemplates({
    casesJsonl: readPinned('injecagent', 'data/attacker_cases_dh.jsonl'),
    prefix: parseInjecAgentPrefix(readPinned('injecagent', 'README.md')),
    enhancedResponses: (
      JSON.parse(readPinned('injecagent', 'data/test_cases_dh_enhanced.json')) as Array<{
        'Tool Response': string;
      }>
    ).map((c) => c['Tool Response']),
    licence,
    commit: PINNED.injecagent.commit,
  });
}

// ---- AgentDojo ----

function unescapePython(s: string): string {
  return s.replace(/\\(n|t|"|'|\\)/g, (_, c: string) => (c === 'n' ? '\n' : c === 't' ? '\t' : c));
}

const PY_STRING = /^\s*(f?)"((?:[^"\\]|\\.)*)"\s*$/;

/** `_JB_STRING = ( "..." "..." )` inside the named class, concatenated and unescaped. */
export function parseJbString(py: string, className: string): string {
  const lines = py.split('\n');
  const start = lines.findIndex((l) => l.startsWith(`class ${className}(`));
  if (start === -1)
    throw new AppError(ErrorCode.CONFIG_INVALID, `AgentDojo: no class ${className}`);
  const open = lines.findIndex((l, i) => i > start && /^\s+_JB_STRING = \($/.test(l));
  if (open === -1) throw new AppError(ErrorCode.CONFIG_INVALID, 'AgentDojo: no _JB_STRING');
  let text = '';
  for (let i = open + 1; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (/^\s+\)\s*$/.test(line)) return text;
    const m = PY_STRING.exec(line);
    if (!m) throw new AppError(ErrorCode.CONFIG_INVALID, `AgentDojo: cannot parse ${line}`);
    text += unescapePython(m[2] ?? '');
  }
  throw new AppError(ErrorCode.CONFIG_INVALID, 'AgentDojo: unterminated _JB_STRING');
}

/** `self.user_name = "..."` in the named class. */
export function parseUserName(py: string, className: string): string {
  const body = py.slice(py.indexOf(`class ${className}(`));
  const m = /self\.user_name = "([^"]+)"/.exec(body);
  if (!m?.[1]) throw new AppError(ErrorCode.CONFIG_INVALID, 'AgentDojo: no user_name');
  return m[1];
}

export function parseModelName(modelsPy: string, key: string): string {
  const m = new RegExp(`"${key}": "([^"]+)"`).exec(modelsPy);
  if (!m?.[1]) throw new AppError(ErrorCode.CONFIG_INVALID, `AgentDojo: no MODEL_NAMES["${key}"]`);
  return m[1];
}

/** GOAL of each InjectionTaskN class, with f-string fields filled from the class's constants. */
export function parseInjectionGoals(py: string): Map<string, string> {
  const goals = new Map<string, string>();
  let cls: string | null = null;
  let vars = new Map<string, string>();
  for (const line of py.split('\n')) {
    const c = /^class (InjectionTask\d+)\(/.exec(line);
    if (c?.[1]) {
      cls = c[1];
      vars = new Map();
      continue;
    }
    if (!cls) continue;
    const a = /^ {4}(\w+) = (f?)"((?:[^"\\]|\\.)*)"\s*$/.exec(line);
    if (!a?.[1]) continue;
    let value = unescapePython(a[3] ?? '');
    if (a[2] === 'f') {
      value = value.replace(/\{(\w+)\}/g, (whole, name: string) => {
        const v = vars.get(name);
        if (v === undefined) {
          throw new AppError(ErrorCode.CONFIG_INVALID, `AgentDojo ${cls}: unknown field ${whole}`);
        }
        return v;
      });
    }
    vars.set(a[1], value);
    if (a[1] === 'GOAL') goals.set(cls, value);
  }
  return goals;
}

/** Python str.format of the jailbreak with goal, user and model; returns the goal's span too. */
export function fillJailbreak(
  jb: string,
  values: { goal: string; user: string; model: string },
): { before: string; after: string } {
  const parts = jb.split('{goal}');
  if (parts.length !== 2) {
    throw new AppError(ErrorCode.CONFIG_INVALID, 'AgentDojo template must contain {goal} once');
  }
  const fill = (s: string) =>
    s.replace(/\{(\w+)\}/g, (whole, name: string) => {
      if (name === 'user') return values.user;
      if (name === 'model') return values.model;
      throw new AppError(ErrorCode.CONFIG_INVALID, `AgentDojo template: unexpected ${whole}`);
    });
  return { before: fill(parts[0] ?? ''), after: fill(parts[1] ?? '') };
}

const AGENTDOJO_V1 = 'src/agentdojo/default_suites/v1/banking/injection_tasks.py';
const AGENTDOJO_V1_2 = 'src/agentdojo/default_suites/v1_2/banking/injection_tasks.py';
const AGENTDOJO_ATTACK = 'src/agentdojo/attacks/important_instructions_attacks.py';
const AGENTDOJO_MODELS = 'src/agentdojo/models.py';
export const AGENTDOJO_CLASS = 'ImportantInstructionsAttack';
/** AgentDojo's default benchmark version (scripts/benchmark.py): banking = v1 tasks + v1.2 updates. */
export const AGENTDOJO_BENCHMARK = 'v1.2.2';

export interface AgentDojoFill {
  user: string;
  model: string;
}

export function agentDojoTemplates(input: {
  v1: string;
  v1_2: string;
  attackPy: string;
  modelsPy: string;
  licence: string;
  commit: string;
}): { templates: GoalTemplate[]; fill: AgentDojoFill } {
  const jb = parseJbString(input.attackPy, AGENTDOJO_CLASS);
  const fill = {
    user: parseUserName(input.attackPy, AGENTDOJO_CLASS),
    model: parseModelName(input.modelsPy, AGENTDOJO_MODEL_KEY),
  };
  const base = parseInjectionGoals(input.v1);
  const updated = parseInjectionGoals(input.v1_2);
  const names = [...base.keys()].sort((a, b) => Number(a.slice(13)) - Number(b.slice(13)));
  const templates = names.map((name) => {
    const fromV12 = updated.has(name);
    const goal = (fromV12 ? updated.get(name) : base.get(name)) as string;
    const { before, after } = fillJailbreak(jb, { goal, ...fill });
    return {
      source: 'agentdojo' as const,
      sourceRef: `${fromV12 ? AGENTDOJO_V1_2 : AGENTDOJO_V1}#${name} + ${AGENTDOJO_ATTACK}#${AGENTDOJO_CLASS}@${input.commit}`,
      before,
      goal,
      after,
      licence: input.licence,
    };
  });
  return { templates, fill };
}

export function loadAgentDojo(): { templates: GoalTemplate[]; fill: AgentDojoFill } {
  const { licence } = readLicence('agentdojo');
  return agentDojoTemplates({
    v1: readPinned('agentdojo', AGENTDOJO_V1),
    v1_2: readPinned('agentdojo', AGENTDOJO_V1_2),
    attackPy: readPinned('agentdojo', AGENTDOJO_ATTACK),
    modelsPy: readPinned('agentdojo', AGENTDOJO_MODELS),
    licence,
    commit: PINNED.agentdojo.commit,
  });
}
