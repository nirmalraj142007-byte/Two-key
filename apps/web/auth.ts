import { hash, verify } from '@node-rs/argon2';
import { users } from '@twokey/db';
import { eq } from 'drizzle-orm';
import NextAuth from 'next-auth';
import Credentials from 'next-auth/providers/credentials';
import { z } from 'zod';
import { db } from './lib/db';
import { webEnv } from './lib/env';

type Role = 'user' | 'judge_demo' | 'hijack_system';

declare module 'next-auth' {
  interface User {
    role?: Role;
  }
  interface Session {
    userId: string;
    role: Role;
  }
}

declare module '@auth/core/jwt' {
  interface JWT {
    userId?: string;
    role?: Role;
  }
}

const LoginInput = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email().max(254)),
  password: z.string().min(1).max(200),
});

// Verified when the email is unknown or has no password, so every failure costs the same
// argon2 work and the response never shows whether the account exists.
let dummyHash: Promise<string> | undefined;

export const { handlers, auth, signIn, signOut } = NextAuth(() => ({
  secret: webEnv().AUTH_SECRET,
  // Render terminates TLS in front of the app; the Host header is the public one.
  trustHost: true,
  session: { strategy: 'jwt' },
  pages: { signIn: '/login' },
  providers: [
    Credentials({
      credentials: { email: {}, password: {} },
      async authorize(raw) {
        const input = LoginInput.safeParse(raw);
        if (!input.success) return null;
        const { email, password } = input.data;
        const [user] = await db()
          .select({ id: users.id, role: users.role, passwordHash: users.passwordHash })
          .from(users)
          .where(eq(users.email, email))
          .limit(1);
        if (!user?.passwordHash) {
          dummyHash ??= hash('two-key-timing-equalizer');
          await verify(await dummyHash, password).catch(() => false);
          return null;
        }
        const ok = await verify(user.passwordHash, password).catch(() => false);
        if (!ok) return null;
        return { id: user.id, role: user.role };
      },
    }),
  ],
  callbacks: {
    jwt({ token, user }) {
      if (user?.id) {
        token.userId = user.id;
        token.role = user.role ?? 'user';
      }
      return token;
    },
    session({ session, token }) {
      if (token.userId && token.role) {
        session.userId = token.userId;
        session.role = token.role;
      }
      return session;
    },
  },
}));
