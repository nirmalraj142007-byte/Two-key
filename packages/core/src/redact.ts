/**
 * Public-page redaction (W17, W18):
 * - every brand name in the evaluation snapshot → "[brand]" (case-insensitive, whole words)
 * - third-party service names in published templates (Venmo, …) → "[service]"; PayPal stays
 * - store domains → their stable pseudonym ("Store 007"); real domains stay in the database
 * - URLs are removed. Public pages never render listing images.
 */

export const BRAND_PLACEHOLDER = '[brand]';
export const SERVICE_PLACEHOLDER = '[service]';

export interface RedactionTerms {
  brands: readonly string[];
  services: readonly string[];
  /** Lower-case store domain → pseudonym. */
  stores?: Readonly<Record<string, string>>;
}

const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"')\]]+/giu;
// Unicode-aware word boundaries: a brand inside a longer word ("Gap" in "gaps") stays.
const BEFORE = '(?<![\\p{L}\\p{N}])';
const AFTER = '(?![\\p{L}\\p{N}])';
// Services also end where a CamelCase identifier continues ("VenmoWithdrawMoney").
const SERVICE_AFTER = '(?![\\p{Ll}\\p{N}])';

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const clean = (xs: readonly string[]) =>
  [...new Set(xs.map((b) => b.trim()).filter((b) => b.length > 0))].sort(
    (a, b) => b.length - a.length,
  );

/** One regex for a term list; longest names first so "Acme Pro" wins over "Acme". */
export function brandPattern(terms: readonly string[]): RegExp | null {
  const names = clean(terms);
  if (names.length === 0) return null;
  return new RegExp(`${BEFORE}(?:${names.map(escapeRe).join('|')})${AFTER}`, 'giu');
}

/** Case variants instead of the i flag, so the lower-case lookahead keeps its meaning. */
export function servicePattern(services: readonly string[]): RegExp | null {
  const variants = clean(
    services.flatMap((s) => [s, s.toLowerCase(), s.toUpperCase(), s.replace(/\s+/g, '')]),
  );
  if (variants.length === 0) return null;
  return new RegExp(`${BEFORE}(?:${variants.map(escapeRe).join('|')})${SERVICE_AFTER}`, 'gu');
}

export type Redactor = (text: string) => string;

/** Builds a redactor once per term set; reuse it for every string on a page. */
export function makeRedactor(terms: RedactionTerms): Redactor {
  const stores = terms.stores ?? {};
  // Stores and brands in one pass, so a pseudonym is never redacted again and "acme.com"
  // becomes its store, not "[brand].com".
  const words = brandPattern([...Object.keys(stores), ...terms.brands]);
  const services = servicePattern(terms.services);
  return (text) => {
    let out = text.replace(URL_RE, '');
    if (services) out = out.replace(services, SERVICE_PLACEHOLDER);
    if (words) out = out.replace(words, (m) => stores[m.toLowerCase()] ?? BRAND_PLACEHOLDER);
    return out;
  };
}

/** Replaces every brand name with "[brand]" and strips URLs. */
export function redactBrands(text: string, brandNames: readonly string[]): string {
  return makeRedactor({ brands: brandNames, services: [] })(text);
}

/** Whole-word, case-insensitive matches of any term in a text (the redaction check uses this). */
export function findTerms(text: string, terms: readonly string[]): string[] {
  const pattern = brandPattern(terms);
  return pattern ? [...text.matchAll(pattern)].map((m) => m[0]) : [];
}

/** Service names, including inside CamelCase identifiers. */
export function findServices(text: string, services: readonly string[]): string[] {
  const pattern = new RegExp(`${BEFORE}(?:${clean(services).map(escapeRe).join('|')})`, 'giu');
  return services.length === 0 ? [] : [...text.matchAll(pattern)].map((m) => m[0]);
}

/** Stable pseudonyms: stores numbered in a fixed order (merchant ID), zero-padded. */
export function storePseudonyms(domainsInOrder: readonly string[]): Record<string, string> {
  const width = Math.max(2, String(domainsInOrder.length).length);
  return Object.fromEntries(
    domainsInOrder.map((d, i) => [d.toLowerCase(), `Store ${String(i + 1).padStart(width, '0')}`]),
  );
}
