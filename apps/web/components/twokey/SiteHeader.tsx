import Link from 'next/link';
import { connection } from 'next/server';
import { Suspense } from 'react';
import { auth } from '@/auth';

const NAV = [
  { href: '/hijack', label: 'Try to hijack it' },
  { href: '/results', label: 'Results' },
  { href: '/developers', label: 'Developers' },
  { href: '/about', label: 'About' },
] as const;

const linkClass =
  'rounded-sm px-1 py-2 text-sm text-text hover:text-accent focus-visible:outline-2 focus-visible:outline-focus';

async function AccountLink() {
  await connection();
  const session = await auth().catch(() => null);
  return session?.userId ? (
    <Link href="/agent" className={`${linkClass} font-medium`}>
      Console
    </Link>
  ) : (
    <SignInLink />
  );
}

function SignInLink() {
  return (
    <Link href="/login" className={`${linkClass} font-medium`}>
      Sign in
    </Link>
  );
}

/** The public pages' header: wordmark in type only, and the five ways in. */
export function SiteHeader() {
  return (
    <header className="border-b border-border bg-surface">
      <div className="mx-auto flex w-full max-w-[1200px] flex-wrap items-center justify-between gap-x-6 gap-y-1 px-4 py-3">
        <Link
          href="/"
          className="rounded-sm text-lg font-semibold tracking-tight text-text focus-visible:outline-2 focus-visible:outline-focus"
        >
          Two-Key
        </Link>
        <nav aria-label="Main" className="w-full sm:w-auto">
          <ul className="flex flex-wrap items-center gap-x-4 gap-y-0">
            {NAV.map((item) => (
              <li key={item.href}>
                <Link href={item.href} className={linkClass}>
                  {item.label}
                </Link>
              </li>
            ))}
            <li>
              <Suspense fallback={<SignInLink />}>
                <AccountLink />
              </Suspense>
            </li>
          </ul>
        </nav>
      </div>
    </header>
  );
}
