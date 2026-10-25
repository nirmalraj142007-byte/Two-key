import { describe, expect, it } from 'vitest';
import { searchWords } from '../src/services/catalog.js';

describe('searchWords', () => {
  it('drops short words, size/under/over and punctuation, case-insensitively', () => {
    expect(searchWords('Running shoes, size 10, under $70')).toEqual(['running', 'shoes']);
    expect(searchWords('OVER Cloud cloud RUNNER')).toEqual(['cloud', 'runner']);
    expect(searchWords('a 10 of')).toEqual([]);
  });
});
