export interface CspInput {
  nonce: string;
  /** The gateway's public URL: the browser opens the event streams there. */
  gatewayUrl: string | undefined;
  dev: boolean;
}

function originOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * The web app's Content-Security-Policy.
 *
 * - Scripts: only those carrying this request's nonce, plus what they load ('strict-dynamic').
 *   'unsafe-eval' only in development (React's dev-only stack reconstruction).
 * - Styles: 'unsafe-inline'. AG Grid, AG Charts, Radix and React `style` props write inline
 *   styles; a style nonce would make browsers ignore 'unsafe-inline' and block them. Inline
 *   styles cannot run script.
 * - connect-src: this origin and the gateway (the console's and inbox's event streams).
 * - worker-src 'self': the push service worker (/sw.js).
 */
export function contentSecurityPolicy({ nonce, gatewayUrl, dev }: CspInput): string {
  const gateway = originOf(gatewayUrl);
  const directives: Record<string, string[]> = {
    'default-src': ["'self'"],
    'script-src': [
      "'self'",
      `'nonce-${nonce}'`,
      "'strict-dynamic'",
      ...(dev ? ["'unsafe-eval'"] : []),
    ],
    'style-src': ["'self'", "'unsafe-inline'"],
    'img-src': ["'self'", 'data:'],
    'font-src': ["'self'"],
    'connect-src': ["'self'", ...(gateway ? [gateway] : [])],
    'worker-src': ["'self'"],
    'manifest-src': ["'self'"],
    'object-src': ["'none'"],
    'base-uri': ["'self'"],
    'form-action': ["'self'"],
    'frame-ancestors': ["'none'"],
  };
  return Object.entries(directives)
    .map(([name, values]) => `${name} ${values.join(' ')}`)
    .join('; ');
}
