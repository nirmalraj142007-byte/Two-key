import type { Metadata } from 'next';
import Link from 'next/link';
import { connection } from 'next/server';
import { Suspense } from 'react';
import { CodeBlock } from '@/components/twokey/CodeBlock';
import { SiteFooter } from '@/components/twokey/SiteFooter';
import { SiteHeader } from '@/components/twokey/SiteHeader';
import {
  CONFIG_AFTER,
  CONFIG_BEFORE,
  DEMO_TOKEN_NOTE,
  NO_MONEY_TOOLS,
  TOOLS,
} from '@/lib/developers-copy';
import { webEnv } from '@/lib/env';

export const metadata: Metadata = { title: 'Developers · Two-Key' };

const linkClass = 'text-accent underline underline-offset-4 hover:no-underline';

async function HttpOption() {
  await connection();
  const code = `URL:    ${webEnv().MCP_PUBLIC_URL}\nHeader: Authorization: Bearer <demo-mode token from Connect your agent>`;
  return <CodeBlock label="Streamable HTTP" code={code} />;
}

export default function DevelopersPage() {
  return (
    <>
      <SiteHeader />
      <main className="mx-auto flex w-full max-w-[1200px] flex-col gap-10 px-4 py-10">
        <header className="flex max-w-3xl flex-col gap-2">
          <h1 className="text-3xl font-semibold tracking-tight text-text">Developers</h1>
          <p className="text-lg text-text">
            For developers shipping agents on PayPal's MCP server. Keep PayPal's read-only tools,
            drop the ones that move money, and add Two-Key.
          </p>
        </header>

        <section aria-labelledby="desktop-title" className="flex flex-col gap-4">
          <div className="flex max-w-3xl flex-col gap-1">
            <h2 id="desktop-title" className="text-xl font-medium text-text">
              Claude Desktop
            </h2>
            <p className="text-base text-text">
              In <code className="font-mono text-sm">claude_desktop_config.json</code>, limit PayPal
              to reading orders and transactions, and add the{' '}
              <code className="font-mono text-sm">twokey</code> server. Keep your existing PayPal{' '}
              <code className="font-mono text-sm">env</code> block.
            </p>
            <p className="text-sm text-text-muted">
              {DEMO_TOKEN_NOTE}{' '}
              <Link href="/onboarding/agent" className={linkClass}>
                Connect your agent
              </Link>
            </p>
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            <CodeBlock label="Before" code={CONFIG_BEFORE} />
            <CodeBlock label="After" code={CONFIG_AFTER} />
          </div>
        </section>

        <section aria-labelledby="http-title" className="flex max-w-3xl flex-col gap-3">
          <h2 id="http-title" className="text-xl font-medium text-text">
            Any MCP client over Streamable HTTP
          </h2>
          <p className="text-base text-text">
            Point the client at the Two-Key MCP URL and send the agent token as a bearer token.
          </p>
          <Suspense fallback={null}>
            <HttpOption />
          </Suspense>
        </section>

        <section aria-labelledby="tools-title" className="flex max-w-3xl flex-col gap-3">
          <h2 id="tools-title" className="text-xl font-medium text-text">
            The four tools
          </h2>
          <ul className="flex flex-col divide-y divide-border rounded-lg border border-border bg-surface-raised">
            {TOOLS.map((t) => (
              <li key={t.name} className="flex flex-col gap-1 p-4">
                <code className="font-mono text-sm font-medium text-text">{t.name}</code>
                <span className="text-sm text-text">{t.text}</span>
              </li>
            ))}
          </ul>
          <p className="text-base font-medium text-text">{NO_MONEY_TOOLS}</p>
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
