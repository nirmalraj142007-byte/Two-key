/**
 * The visitor's IP for rate limiting: the RIGHTMOST x-forwarded-for entry, which our own proxy
 * (Render's) appends from the TCP connection. Entries to its left come from the client and can
 * be anything, so they never pick the rate-limit key. Falls back to x-real-ip, then 'unknown'.
 */
export function clientIp(headers: Headers): string {
  const entries = (headers.get('x-forwarded-for') ?? '')
    .split(',')
    .map((e) => e.trim())
    .filter((e) => e !== '');
  return entries.at(-1) || headers.get('x-real-ip')?.trim() || 'unknown';
}
