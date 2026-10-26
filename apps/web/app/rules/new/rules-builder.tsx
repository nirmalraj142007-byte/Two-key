'use client';

import { useState, useTransition } from 'react';
import { RuleLine } from '@/components/twokey/rule-line';
import { PartialNotice } from '@/components/twokey/state-panels';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import type { Failure } from '@/lib/onboarding';
import { type DraftView, needsInputPrompt, ruleLines, type StoreOption } from '@/lib/rules-view';
import { signRules } from '../../onboarding/actions';
import { FailureNotice } from '../../onboarding/failure-notice';
import { ManualRulesForm } from './manual-form';

export const EXAMPLE_REQUEST =
  'Running shoes, size 10, under $70, only Stride Supply or Peak Outfitters, one pair, this week.';

type Phase =
  | { kind: 'input' }
  | { kind: 'compiling' }
  | { kind: 'manual' }
  | { kind: 'review'; draft: DraftView }
  | { kind: 'error'; failure: Failure };

const RETRY = { label: 'Try again' };

/** Maps the compile route's response to the next screen. No error codes reach the page. */
async function readCompile(res: Response): Promise<Phase> {
  const body = (await res.json().catch(() => null)) as
    | (DraftView & { fallback?: string; error?: { message?: string } })
    | null;
  if (res.ok && body) return { kind: 'review', draft: body };
  if (res.status === 503 && body?.fallback === 'manual') return { kind: 'manual' };
  if (res.status === 401) {
    return {
      kind: 'error',
      failure: { message: 'Your sign-in has expired.', next: { label: 'Sign in', href: '/login' } },
    };
  }
  if (res.status === 429) {
    return {
      kind: 'error',
      failure: { message: 'The rule builder is busy. Wait a minute and try again.', next: RETRY },
    };
  }
  if (res.status === 400 && body?.error?.message) {
    return { kind: 'error', failure: { message: body.error.message, next: RETRY } };
  }
  return {
    kind: 'error',
    failure: { message: "We couldn't build your rules. Nothing was saved.", next: RETRY },
  };
}

function CompilingCard() {
  return (
    <Card aria-busy="true">
      <CardHeader>
        <CardTitle className="text-lg">Building your rules…</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4" role="status">
        <span className="sr-only">Building your rules…</span>
        {[0, 1, 2, 3].map((i) => (
          <div key={i} aria-hidden="true" className="flex items-center justify-between gap-4">
            <div className="flex flex-1 flex-col gap-2">
              <Skeleton className="h-3 w-1/4" />
              <Skeleton className="h-4 w-2/5" />
            </div>
            <Skeleton className="h-6 w-36 rounded-full" />
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function ReviewCard({
  draft,
  stores,
  onEdit,
}: {
  draft: DraftView;
  stores: StoreOption[];
  onEdit: () => void;
}) {
  const [pending, startTransition] = useTransition();
  const [failure, setFailure] = useState<Failure | null>(null);
  const sign = () => {
    if (!draft.draftId) return;
    const id = draft.draftId;
    setFailure(null);
    startTransition(async () => {
      const result = await signRules(id);
      if (result?.status === 'error') setFailure(result.failure);
    });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">Check your rules</CardTitle>
        <CardDescription>
          Rules marked “Enforced at payment” are checked by Two-Key before any money moves.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {draft.card ? (
          <div className="divide-y divide-border">
            {ruleLines(draft.card, draft.enforcement, stores).map((l) => (
              <RuleLine key={l.key} label={l.label} value={l.value} enforcement={l.enforcement} />
            ))}
          </div>
        ) : null}
        {draft.needsInput.length > 0 ? (
          <div className="flex flex-col gap-2" data-testid="needs-input">
            {draft.needsInput.map((n) => (
              <p
                key={n}
                className="rounded-sm border border-dashed border-border px-3 py-2 text-sm"
              >
                {needsInputPrompt(n)}
              </p>
            ))}
          </div>
        ) : null}
        {draft.warnings.map((w) => (
          <PartialNotice key={w} text={w} />
        ))}
        {failure ? <FailureNotice failure={failure} retry={sign} /> : null}
      </CardContent>
      <CardFooter className="flex flex-wrap gap-3">
        {draft.card && draft.draftId ? (
          <Button size="lg" onClick={sign} disabled={pending}>
            {pending ? 'Signing…' : 'Confirm & sign'}
          </Button>
        ) : null}
        <Button variant="outline" size="lg" onClick={onEdit} disabled={pending}>
          {draft.card ? 'Change request' : 'Add the missing details'}
        </Button>
      </CardFooter>
    </Card>
  );
}

export function RulesBuilder({ stores }: { stores: StoreOption[] }) {
  const [request, setRequest] = useState('');
  const [phase, setPhase] = useState<Phase>({ kind: 'input' });

  const build = async () => {
    setPhase({ kind: 'compiling' });
    try {
      const res = await fetch('/api/rules/compile', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ request }),
      });
      setPhase(await readCompile(res));
    } catch {
      setPhase({
        kind: 'error',
        failure: { message: "We couldn't reach Two-Key. Nothing was saved.", next: RETRY },
      });
    }
  };

  if (phase.kind === 'manual') {
    return (
      <ManualRulesForm stores={stores} onDraft={(draft) => setPhase({ kind: 'review', draft })} />
    );
  }
  if (phase.kind === 'review') {
    return (
      <ReviewCard draft={phase.draft} stores={stores} onEdit={() => setPhase({ kind: 'input' })} />
    );
  }

  const compiling = phase.kind === 'compiling';
  return (
    <div className="flex flex-col gap-4">
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          void build();
        }}
      >
        <label htmlFor="request" className="text-sm font-medium text-text">
          What may your agent buy?
        </label>
        <Textarea
          id="request"
          name="request"
          rows={4}
          maxLength={1000}
          placeholder={EXAMPLE_REQUEST}
          value={request}
          onChange={(e) => setRequest(e.target.value)}
          disabled={compiling}
          required
        />
        <Button
          type="submit"
          size="lg"
          className="w-fit"
          disabled={compiling || request.trim() === ''}
        >
          {compiling ? 'Building…' : 'Build my rules'}
        </Button>
      </form>
      {compiling ? <CompilingCard /> : null}
      {phase.kind === 'error' ? (
        <FailureNotice failure={phase.failure} retry={() => void build()} />
      ) : null}
    </div>
  );
}
