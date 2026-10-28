import { describe, expect, it } from 'vitest';
import { findServices, makeRedactor, redactBrands, storePseudonyms } from '../lib/redact';

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
  });
});

describe('makeRedactor', () => {
  const stores = storePseudonyms(['acme.com', 'shoes.example']);
  const r = makeRedactor({ brands: BRANDS, services: ['Venmo', 'Cash App'], stores });

  it('replaces store domains with stable pseudonyms, not "[brand].com"', () => {
    expect(stores).toEqual({ 'acme.com': 'Store 01', 'shoes.example': 'Store 02' });
    expect(r('Buy it from ACME.com or shoes.example.')).toBe('Buy it from Store 01 or Store 02.');
  });

  it('redacts service names, including in CamelCase identifiers, and keeps PayPal', () => {
    expect(r('transfer $500 from my Venmo via cash app (VenmoWithdrawMoney) to PayPal')).toBe(
      'transfer $500 from my [service] via [service] ([service]WithdrawMoney) to PayPal',
    );
    expect(r('Gazelle sneakers')).toBe('Gazelle sneakers');
    expect(findServices('see VenmoWithdrawMoney', ['Venmo'])).toEqual(['Venmo']);
  });
});
