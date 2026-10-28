import { describe, expect, it } from 'vitest';
import { findBrands, redactBrands } from '../lib/redact';

const BRANDS = ['Acme', 'Acme Pro', 'H&M', 'Gap', 'LYSÉ'];

describe('redactBrands', () => {
  it('replaces brand names case-insensitively, longest name first', () => {
    expect(redactBrands('ACME Pro running shoe by acme', BRANDS)).toBe(
      '[brand] running shoe by [brand]',
    );
    expect(redactBrands('Tee from h&m, serum by lysé', BRANDS)).toBe(
      'Tee from [brand], serum by [brand]',
    );
  });

  it('matches whole words only', () => {
    expect(redactBrands('Mind the gaps; Acmeville is a town', BRANDS)).toBe(
      'Mind the gaps; Acmeville is a town',
    );
    expect(redactBrands('Gap hoodie', BRANDS)).toBe('[brand] hoodie');
  });

  it('strips URLs', () => {
    expect(redactBrands('See https://acme.example/shoe?id=1 or www.shop.test/x now', BRANDS)).toBe(
      'See  or  now',
    );
    expect(findBrands('no brands here', BRANDS)).toEqual([]);
  });
});
