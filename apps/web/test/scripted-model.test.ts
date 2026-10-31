import { afterEach, describe, expect, it, vi } from 'vitest';

const allow = vi.hoisted(() => ({ value: undefined as string | undefined }));
vi.mock('@/lib/env', () => ({ webEnv: () => ({ ALLOW_SCRIPTED: allow.value }) }));

import { scriptedAllowed } from '@/lib/scripted-model';

afterEach(() => {
  vi.unstubAllEnvs();
  allow.value = undefined;
});

describe('scriptedAllowed', () => {
  it('accepts only scripted:<name>', () => {
    vi.stubEnv('NODE_ENV', 'development');
    expect(scriptedAllowed('scripted:happy')).toBe(true);
    for (const m of ['openai/gpt-oss-120b', 'scripted:', 'scripted:../x', 'scripted:A b']) {
      expect(scriptedAllowed(m)).toBe(false);
    }
  });

  it('is refused in production unless ALLOW_SCRIPTED=true', () => {
    vi.stubEnv('NODE_ENV', 'production');
    expect(scriptedAllowed('scripted:happy')).toBe(false);
    allow.value = 'false';
    expect(scriptedAllowed('scripted:happy')).toBe(false);
    allow.value = 'true';
    expect(scriptedAllowed('scripted:happy')).toBe(true);
  });
});
