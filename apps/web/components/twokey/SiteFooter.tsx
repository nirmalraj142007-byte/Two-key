import { REPO_URL } from '@/lib/results-queries';

export function SiteFooter() {
  return (
    <footer className="mt-auto border-t border-border bg-surface">
      <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-2 px-4 py-6 text-sm text-text-muted sm:flex-row sm:items-center sm:justify-between">
        <p>All products and merchants are fictional PayPal sandbox accounts.</p>
        <ul className="flex gap-4">
          <li>
            <a className="text-text underline underline-offset-4 hover:text-accent" href={REPO_URL}>
              GitHub
            </a>
          </li>
          <li>
            <a
              className="text-text underline underline-offset-4 hover:text-accent"
              href={`${REPO_URL}#readme`}
            >
              README
            </a>
          </li>
        </ul>
      </div>
    </footer>
  );
}
