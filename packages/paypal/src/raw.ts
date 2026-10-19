/** Reads a string field from raw PayPal JSON; anything else becomes ''. */
export function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

export function obj(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}

export function first(v: unknown): Record<string, unknown> {
  return Array.isArray(v) ? obj(v[0]) : {};
}
