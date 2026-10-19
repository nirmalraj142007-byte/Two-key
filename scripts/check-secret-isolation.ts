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
  services?: { name?: string; envVars?: { key?: string }[] }[];
}

/** Returns one message per secret found on a service that may not hold it. */
export function findViolations(blueprint: RenderBlueprint): string[] {
  const violations: string[] = [];
  for (const service of blueprint.services ?? []) {
    const name = service.name ?? '';
    const mapped = RENDER_TO_SERVICE[name];
    for (const { key } of service.envVars ?? []) {
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
  const violations = findViolations(parse(readFileSync(file, 'utf8')) as RenderBlueprint);
  if (violations.length > 0) {
    for (const v of violations) process.stderr.write(`${v}\n`);
    process.exit(1);
  }
  process.stdout.write('secret isolation OK (4 services)\n');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
