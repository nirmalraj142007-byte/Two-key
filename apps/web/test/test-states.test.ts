import { afterEach, describe, expect, it, vi } from 'vitest';
import { readForced, readForcedState } from '../lib/test-states';

afterEach(() => vi.unstubAllEnvs());

describe('readForcedState', () => {
  it('reads ?__state= outside production', () => {
    vi.stubEnv('NODE_ENV', 'development');
    expect(readForcedState({ __state: 'loading' })).toBe('loading');
    expect(readForcedState(new URLSearchParams('__state=error'))).toBe('error');
    expect(readForcedState({ __state: ['empty', 'error'] })).toBe('empty');
    expect(readForced({ __state: 'partial' }, ['empty', 'partial'] as const)).toBe('partial');
    expect(readForced({ __state: 'other' }, ['empty'] as const)).toBeNull();
  });

  it('rejects odd values', () => {
    vi.stubEnv('NODE_ENV', 'test');
    expect(readForcedState({ __state: '<script>' })).toBeNull();
    expect(readForcedState({})).toBeNull();
    expect(readForcedState(undefined)).toBeNull();
  });

  it('is impossible in production', () => {
    vi.stubEnv('NODE_ENV', 'production');
    expect(readForcedState({ __state: 'loading' })).toBeNull();
    expect(readForcedState(new URLSearchParams('__state=error'))).toBeNull();
    expect(readForced({ __state: 'empty' }, ['empty'] as const)).toBeNull();
  });
});
