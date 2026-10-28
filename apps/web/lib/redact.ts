/**
 * Public-page redaction (W17, W18). Every brand name in the evaluation snapshot becomes
 * "[brand]" (case-insensitive, whole words only) and URLs are removed. Public pages never
 * render listing images.
 */

export const BRAND_PLACEHOLDER = '[brand]';

const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"')\]]+/giu;
// Unicode-aware word boundaries: a brand inside a longer word ("Gap" in "gaps") stays.
const BEFORE = '(?<![\\p{L}\\p{N}])';
const AFTER = '(?![\\p{L}\\p{N}])';

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** One regex for a brand list; longest names first so "Nike Air" wins over "Nike". */
export function brandPattern(brandNames: readonly string[]): RegExp | null {
  const names = [...new Set(brandNames.map((b) => b.trim()).filter((b) => b.length > 0))].sort(
    (a, b) => b.length - a.length,
  );
  if (names.length === 0) return null;
  return new RegExp(`${BEFORE}(?:${names.map(escapeRe).join('|')})${AFTER}`, 'giu');
}

const cache = new WeakMap<readonly string[], RegExp | null>();

function patternFor(brandNames: readonly string[]): RegExp | null {
  if (!cache.has(brandNames)) cache.set(brandNames, brandPattern(brandNames));
  return cache.get(brandNames) ?? null;
}

/** Replaces every brand name with "[brand]" and strips URLs. */
export function redactBrands(text: string, brandNames: readonly string[]): string {
  const pattern = patternFor(brandNames);
  const noUrls = text.replace(URL_RE, '');
  return pattern ? noUrls.replace(pattern, BRAND_PLACEHOLDER) : noUrls;
}

/** Whole-word, case-insensitive brand matches in a text (the redaction check uses this). */
export function findBrands(text: string, brandNames: readonly string[]): string[] {
  const pattern = patternFor(brandNames);
  if (!pattern) return [];
  return [...text.matchAll(pattern)].map((m) => m[0]);
}
