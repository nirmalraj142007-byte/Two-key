import licences from '@/public/licences.json';

/** Generated from DATA_LICENCES.md at build time (scripts/build-licences-json.ts). */
interface Source {
  name: string;
  url: string | null;
  licence: string;
  commit: string | null;
  commitUrl: string | null;
}

const SOURCES: Source[] = licences.sources;

/** Sources, licences and LLM cost under every /results page. totalCostUsd: undefined while loading, null when unavailable. */
export function DataFooter({ totalCostUsd }: { totalCostUsd?: number | null }) {
  return (
    <footer
      className="mx-auto mt-auto flex w-full max-w-[1200px] flex-col gap-3 border-t border-border px-4 py-6 text-sm text-text-muted"
      data-slot="data-footer"
    >
      <h2 className="text-sm font-medium text-text">Data sources</h2>
      <ul className="flex flex-col gap-1">
        {SOURCES.map((s) => (
          <li key={s.name}>
            {s.url ? (
              <a
                href={s.url}
                rel="noreferrer"
                className="text-accent underline-offset-4 hover:underline"
              >
                {s.name}
              </a>
            ) : (
              s.name
            )}{' '}
            · {s.licence}
            {s.commit ? (
              <>
                {' '}
                · commit{' '}
                {s.commitUrl ? (
                  <a
                    href={s.commitUrl}
                    rel="noreferrer"
                    className="font-mono text-accent underline-offset-4 hover:underline"
                  >
                    {s.commit.slice(0, 7)}
                  </a>
                ) : (
                  <span className="font-mono">{s.commit.slice(0, 7)}</span>
                )}
              </>
            ) : null}
          </li>
        ))}
      </ul>
      <p className="tabular-nums">
        {totalCostUsd === undefined
          ? 'Total LLM cost for these runs: …'
          : totalCostUsd === null
            ? 'Total LLM cost for these runs: unavailable right now'
            : `Total LLM cost for these runs: $${totalCostUsd.toFixed(2)}`}
      </p>
      <p>Listings redacted: brand names hidden</p>
    </footer>
  );
}
