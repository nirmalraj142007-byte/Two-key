import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SECRET_OWNERS, type ServiceName } from '@twokey/core';
import { parse } from 'yaml';

const RENDER_TO_SERVICE: Record<string, ServiceName> = {
  web: 'web',
  gateway: 'gateway',
  'twokey-mcp': 'mcp',
  'agent-runner': 'agent-runner',
};

interface RenderBlueprint {
  services?: {
    name?: string;
    branch?: string;
    envVars?: { key?: string; value?: unknown }[];
  }[];
}

/** Local-only settings that must never be deployed. */
const NEVER_DEPLOYED = ['EVAL_ENABLED', 'EVAL_ADMIN_TOKEN', 'SHOW_STYLEGUIDE'];

/** The one public environment deploys from this branch (docs/DEPLOY.md). */
const RELEASE_BRANCH = 'release';

/** Returns one message per secret found on a service that may not hold it. */
export function findViolations(blueprint: RenderBlueprint): string[] {
  const violations: string[] = [];
  for (const service of blueprint.services ?? []) {
    const name = service.name ?? '';
    const mapped = RENDER_TO_SERVICE[name];
    if (mapped === undefined) {
      violations.push(
        `${name || '(unnamed)'} is not one of: ${Object.keys(RENDER_TO_SERVICE).join(', ')}`,
      );
    }
    if (service.branch !== undefined && service.branch !== RELEASE_BRANCH) {
      violations.push(`${name} deploys from ${service.branch}; only ${RELEASE_BRANCH} may deploy`);
    }
    for (const { key, value } of service.envVars ?? []) {
      if (key === 'NODE_ENV' && value !== undefined && value !== 'production') {
        violations.push(`NODE_ENV must be production (found ${String(value)} on ${name})`);
      }
      if (key !== undefined && NEVER_DEPLOYED.includes(key)) {
        violations.push(`${key} is local-only and must not be in render.yaml (found on ${name})`);
        continue;
      }
      const owners = key === undefined ? undefined : SECRET_OWNERS[key];
      if (key === undefined || owners === undefined) continue;
      if (mapped === undefined || !owners.includes(mapped)) {
        violations.push(`${key} may only be set on: ${owners.join(', ')} (found on ${name})`);
      }
    }
  }
  return violations;
}

function main(): void {
  const file = resolve(process.argv[2] ?? 'render.yaml');
  const blueprint = parse(readFileSync(file, 'utf8')) as RenderBlueprint;
  const violations = findViolations(blueprint);
  if (violations.length > 0) {
    for (const v of violations) process.stderr.write(`${v}\n`);
    process.exit(1);
  }
  process.stdout.write(`secret isolation OK (${blueprint.services?.length ?? 0} services)\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
