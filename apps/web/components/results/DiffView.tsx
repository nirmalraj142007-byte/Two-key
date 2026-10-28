import type { SourceRef } from '@/lib/episodes-view';
import { cn } from '@/lib/utils';

type LineKind = 'add' | 'remove' | 'hunk' | 'header' | 'context';

function kindOf(line: string): LineKind {
  if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('===')) return 'header';
  if (line.startsWith('Index:') || line.startsWith('\\')) return 'header';
  if (line.startsWith('@@')) return 'hunk';
  if (line.startsWith('+')) return 'add';
  if (line.startsWith('-')) return 'remove';
  return 'context';
}

const LINE_CLASS: Record<LineKind, string> = {
  add: 'bg-state-captured-bg text-state-captured-fg',
  remove: 'bg-state-blocked-bg text-state-blocked-fg',
  hunk: 'text-text-muted',
  header: 'text-text-muted',
  context: 'text-text',
};

const LINE_LABEL: Partial<Record<LineKind, string>> = { add: 'Added', remove: 'Removed' };

/** A unified diff of the published attack template against our adapted copy. */
export function DiffView({
  diff,
  source,
  sourceRef,
  refLinks,
  licence,
}: {
  diff: string;
  source: string;
  sourceRef: string;
  refLinks: SourceRef;
  licence: string;
}) {
  const lines = diff.replace(/\n$/, '').split('\n');
  const changed = lines.filter((l) => {
    const k = kindOf(l);
    return k === 'add' || k === 'remove';
  }).length;
  return (
    <figure className="flex flex-col gap-2" data-slot="diff-view">
      <figcaption className="flex flex-col gap-1 text-sm">
        <span className="font-medium text-text">Published template, goal adapted</span>
        <span className="text-text-muted">
          {source === 'injecagent' ? 'InjecAgent' : source === 'agentdojo' ? 'AgentDojo' : source} ·{' '}
          {licence} · {changed} changed {changed === 1 ? 'line' : 'lines'}
        </span>
        <span className="text-text-muted">
          Red lines are the published goal; green lines are the purchase goal that replaced it.
        </span>
      </figcaption>
      <pre className="max-h-[420px] overflow-auto rounded-lg border border-border bg-surface py-2 font-mono text-xs leading-5">
        {lines.map((line, i) => {
          const kind = kindOf(line);
          const label = LINE_LABEL[kind];
          return (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: diff lines are static and ordered.
              key={i}
              data-kind={kind}
              className={cn('whitespace-pre-wrap break-words px-3', LINE_CLASS[kind])}
            >
              {label ? <span className="sr-only">{label}: </span> : null}
              {line || ' '}
            </div>
          );
        })}
      </pre>
      <dl className="grid gap-x-3 gap-y-1 text-xs text-text-muted sm:grid-cols-[auto_1fr]">
        <dt>Source</dt>
        <dd className="break-all font-mono">{sourceRef}</dd>
        {refLinks.files.map((f) => (
          <div key={`${f.file}#${f.caseId}`} className="contents">
            <dt>File</dt>
            <dd className="break-all">
              {f.url ? (
                <a
                  href={f.url}
                  className="font-mono text-accent underline-offset-4 hover:underline"
                  rel="noreferrer"
                >
                  {f.file}
                </a>
              ) : (
                <span className="font-mono">{f.file}</span>
              )}
              {f.caseId ? <span> · case {f.caseId}</span> : null}
            </dd>
          </div>
        ))}
        {refLinks.commit ? (
          <>
            <dt>Commit</dt>
            <dd>
              {refLinks.commitUrl ? (
                <a
                  href={refLinks.commitUrl}
                  className="font-mono text-accent underline-offset-4 hover:underline"
                  rel="noreferrer"
                >
                  {refLinks.commit.slice(0, 12)}
                </a>
              ) : (
                <span className="font-mono">{refLinks.commit.slice(0, 12)}</span>
              )}
            </dd>
          </>
        ) : null}
      </dl>
    </figure>
  );
}
