import { randomUUID } from 'node:crypto';
import { importPKCS8, SignJWT } from 'jose';
import { webEnv } from './env';

export type Scope =
  | 'vault:manage'
  | 'rules:sign'
  | 'sessions:create'
  | 'approvals:decide'
  | 'events:read'
  | 'push:manage'
  | 'hijack:create';

const LIFETIME_S = 60;

let key: ReturnType<typeof importPKCS8> | undefined;

/** A 60-second EdDSA assertion that the gateway accepts once, for exactly these scopes. */
export async function mintAssertion(userId: string, role: string, scope: Scope[]): Promise<string> {
  key ??= importPKCS8(webEnv().HUMAN_ASSERTION_PRIVATE_KEY, 'EdDSA');
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ role, scope: scope.join(' ') })
    .setProtectedHeader({ alg: 'EdDSA' })
    .setIssuer('twokey-web')
    .setAudience('twokey-gateway')
    .setSubject(userId)
    .setJti(randomUUID())
    .setIssuedAt(now)
    .setExpirationTime(now + LIFETIME_S)
    .sign(await key);
}
