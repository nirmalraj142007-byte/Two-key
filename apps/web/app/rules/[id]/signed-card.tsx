import Link from 'next/link';
import { RuleLine } from '@/components/twokey/rule-line';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import type { RuleLineView } from '@/lib/rules-view';

const STATUS_TEXT = {
  signed: 'Signed',
  draft: 'Draft — not signed',
  revoked: 'Replaced',
  expired: 'Expired',
} as const;

const fmt = (d: Date) =>
  new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeZone: 'UTC' }).format(d);

/** One rule card as signed (or not): status, expiry, fingerprint and every rule line. */
export function SignedCardView({
  version,
  status,
  expiresAt,
  fingerprint,
  lines,
}: {
  version: number;
  status: keyof typeof STATUS_TEXT;
  expiresAt: Date | null;
  fingerprint: string | null;
  lines: RuleLineView[];
}) {
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle className="text-xl">Your rules, version {version}</CardTitle>
          <Badge variant="outline">{STATUS_TEXT[status]}</Badge>
        </div>
        <CardDescription className="text-base">
          {status === 'signed' ? 'From here, no AI decides.' : 'These rules are not active.'}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-sm">
          <dt className="text-text-muted">Expires</dt>
          <dd className="text-text">{expiresAt ? fmt(expiresAt) : '—'}</dd>
          <dt className="text-text-muted">Fingerprint</dt>
          <dd className="font-mono text-text" data-testid="fingerprint">
            {fingerprint ?? 'Not signed'}
          </dd>
        </dl>
        <div className="divide-y divide-border">
          {lines.map((l) => (
            <RuleLine key={l.key} label={l.label} value={l.value} enforcement={l.enforcement} />
          ))}
        </div>
      </CardContent>
      <CardFooter className="flex flex-wrap gap-3">
        {status === 'signed' ? (
          <Button asChild size="lg">
            <Link href="/onboarding/agent">Continue to your agent</Link>
          </Button>
        ) : null}
        <Button asChild variant="outline" size="lg">
          <Link href="/rules/new">Change rules</Link>
        </Button>
      </CardFooter>
    </Card>
  );
}
