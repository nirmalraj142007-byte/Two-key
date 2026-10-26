import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { Banner } from '@/components/twokey/banner';
import { Money } from '@/components/twokey/money';
import { PaymentRow } from '@/components/twokey/payment-row';
import { PayPalId } from '@/components/twokey/paypal-id';
import { RuleLine } from '@/components/twokey/rule-line';
import { type BadgeState, STATE_LABEL, StateBadge } from '@/components/twokey/state-badge';
import { EmptyState, LoadingState, PartialNotice } from '@/components/twokey/state-panels';
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
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { CountdownDemo, ErrorDemo, ThemeToggle, ToastDemo } from './demos';

export const metadata: Metadata = { title: 'Styleguide · Two-Key', robots: { index: false } };

// Fictional sandbox-style IDs for display only.
const IDS = {
  order: '5O190127TN364715T',
  authorization: '0VF52814937998046',
  capture: '3C679366HH908993F',
  merchant: 'STRIDESUPPLY01',
  debug: 'f3a1c09be2d4a',
} as const;

const STATES = Object.keys(STATE_LABEL) as BadgeState[];

const SWATCHES: Array<{ name: string; className: string }> = [
  { name: '--bg', className: 'bg-bg' },
  { name: '--surface', className: 'bg-surface' },
  { name: '--surface-raised', className: 'bg-surface-raised' },
  { name: '--text', className: 'bg-text' },
  { name: '--text-muted', className: 'bg-text-muted' },
  { name: '--border', className: 'bg-border' },
  { name: '--accent', className: 'bg-accent' },
  { name: '--focus', className: 'bg-focus' },
];

const STATE_SWATCHES: Array<{ name: string; bg: string; fg: string }> = [
  { name: 'captured', bg: 'bg-state-captured-bg', fg: 'bg-state-captured-fg' },
  { name: 'held', bg: 'bg-state-held-bg', fg: 'bg-state-held-fg' },
  { name: 'blocked', bg: 'bg-state-blocked-bg', fg: 'bg-state-blocked-fg' },
  { name: 'voided / expired', bg: 'bg-state-voided-bg', fg: 'bg-state-voided-fg' },
];

const TYPE_SCALE: Array<[string, string]> = [
  ['text-3xl', '40 / 48'],
  ['text-2xl', '32 / 40'],
  ['text-xl', '24 / 32'],
  ['text-lg', '20 / 28'],
  ['text-base', '16 / 24'],
  ['text-sm', '14 / 20'],
  ['text-xs', '12 / 16'],
];

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="flex flex-col gap-4">
      <h2 id={id} className="text-xl font-semibold tracking-tight text-text">
        {title}
      </h2>
      {children}
    </section>
  );
}

export default function StyleguidePage() {
  if (process.env.NODE_ENV === 'production' && !process.env.SHOW_STYLEGUIDE) notFound();

  return (
    <main className="mx-auto flex w-full max-w-4xl flex-col gap-12 px-4 py-10 sm:px-8">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex flex-col gap-1">
          <p className="text-sm font-medium text-text-muted">Two-Key design system</p>
          <h1 className="text-2xl font-semibold tracking-tight text-text">Styleguide</h1>
        </div>
        <ThemeToggle />
      </header>

      <Section id="colours" title="Colour tokens">
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {SWATCHES.map((s) => (
            <li key={s.name} className="flex flex-col gap-1.5">
              <span
                aria-hidden="true"
                className={`h-12 rounded-sm border border-border ${s.className}`}
              />
              <code className="font-mono text-xs text-text-muted">{s.name}</code>
            </li>
          ))}
        </ul>
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {STATE_SWATCHES.map((s) => (
            <li key={s.name} className="flex flex-col gap-1.5">
              <span aria-hidden="true" className="flex h-12 overflow-hidden rounded-sm">
                <span className={`flex-1 ${s.bg}`} />
                <span className={`w-1/3 ${s.fg}`} />
              </span>
              <code className="font-mono text-xs text-text-muted">--state-{s.name}</code>
            </li>
          ))}
        </ul>
      </Section>

      <Section id="type" title="Type scale">
        <ul className="flex flex-col gap-2">
          {TYPE_SCALE.map(([cls, size]) => (
            <li key={cls} className="flex items-baseline justify-between gap-4">
              <span className={`${cls} truncate text-text`}>Authorize, then decide</span>
              <code className="shrink-0 font-mono text-xs text-text-muted">
                {cls} · {size}
              </code>
            </li>
          ))}
        </ul>
      </Section>

      <Section id="state-badges" title="Payment state badges">
        <ul className="flex flex-wrap gap-2">
          {STATES.map((s) => (
            <li key={s}>
              <StateBadge state={s} />
            </li>
          ))}
        </ul>
      </Section>

      <Section id="payment-rows" title="Payment rows">
        <ul className="flex flex-col gap-3">
          <PaymentRow
            as="li"
            product="Cloud Runner CR-1"
            merchant="Stride Supply"
            cents={5400}
            state="captured"
            ids={{
              orderId: IDS.order,
              authorizationId: IDS.authorization,
              captureId: IDS.capture,
            }}
          />
          <PaymentRow
            as="li"
            product="Trail Runner TR-2"
            merchant="Peak Outfitters"
            cents={6440}
            state="held"
            reason="40% above the usual price at 3 stores."
            ids={{ orderId: IDS.order, authorizationId: IDS.authorization }}
          />
          <PaymentRow
            as="li"
            product="Digital gift card"
            merchant="GiftVault"
            cents={18900}
            state="blocked"
            reason="GiftVault is not on your list of allowed stores. No PayPal order created."
            ids={{}}
          />
          <PaymentRow
            as="li"
            product="Trail Runner TR-2"
            merchant="Peak Outfitters"
            cents={6440}
            state="voided"
            reason="You said no. The hold was released."
            ids={{ orderId: IDS.order, authorizationId: IDS.authorization }}
          />
          <PaymentRow
            as="li"
            product="Trail Runner TR-2"
            merchant="Peak Outfitters"
            cents={6440}
            state="expired"
            reason="No answer within 15 minutes, so the hold was released."
            ids={{ orderId: IDS.order, authorizationId: IDS.authorization }}
          />
          <PaymentRow
            as="li"
            product="Cloud Runner CR-1"
            merchant="Stride Supply"
            cents={5400}
            state="capture_requested"
            ids={{ orderId: IDS.order, authorizationId: IDS.authorization }}
          />
          <PaymentRow
            as="li"
            product="Cloud Runner CR-1"
            merchant="Stride Supply"
            cents={5400}
            state="failed"
            reason="Not purchased — retry. PayPal could not be reached."
            ids={{}}
          />
        </ul>
      </Section>

      <Section id="rules" title="Rule lines">
        <div className="flex flex-col divide-y divide-border rounded-md border border-border bg-surface-raised px-4">
          <RuleLine
            label="Price limit"
            value={<Money cents={7000} currency="USD" />}
            enforcement="enforced"
          />
          <RuleLine
            label="Stores"
            value="Stride Supply or Peak Outfitters"
            enforcement="enforced"
          />
          <RuleLine label="Size" value="10" enforcement="advisory" />
          <RuleLine label="Hold time" value="15 minutes" enforcement="default" />
        </div>
      </Section>

      <Section id="money-ids" title="Money and PayPal IDs">
        <div className="flex flex-wrap items-center gap-6">
          <Money cents={5400} currency="USD" className="text-xl font-semibold" />
          <Money cents={6440} currency="USD" />
          <Money cents={18900} currency="USD" inGrid />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <PayPalId id={IDS.order} kind="order" />
          <PayPalId id={IDS.authorization} kind="authorization" />
          <PayPalId id={IDS.capture} kind="capture" />
          <PayPalId id={IDS.merchant} kind="merchant" />
          <PayPalId id={IDS.debug} kind="debug" />
        </div>
        <table className="w-full max-w-md text-sm">
          <caption className="sr-only">Numbers are right-aligned in tables</caption>
          <thead>
            <tr className="border-b border-border text-left text-text-muted">
              <th scope="col" className="py-2 font-medium">
                Store
              </th>
              <th scope="col" className="num py-2 font-medium">
                Price
              </th>
            </tr>
          </thead>
          <tbody>
            {(
              [
                ['Stride Supply', 4400],
                ['Pacer Goods', 4600],
                ['Peak Outfitters', 6440],
              ] as const
            ).map(([store, cents]) => (
              <tr key={store} className="border-b border-border">
                <td className="py-2 text-text">{store}</td>
                <td className="num py-2 text-text">
                  <Money cents={cents} currency="USD" inGrid />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      <Section id="countdown" title="Countdown">
        <CountdownDemo />
      </Section>

      <Section id="banners" title="Banners">
        <Banner tone="info" text="Your rules are signed. The agent can shop within them." />
        <Banner tone="warning" text="Your PayPal wallet is not connected yet." />
        <Banner tone="replay" text="Replaying a recorded run" />
      </Section>

      <Section id="panels" title="Empty, loading, error and partial">
        <EmptyState
          title="No purchases yet"
          body="When the agent proposes a purchase, it shows up here."
          action={<Button variant="outline">Start a session</Button>}
        />
        <LoadingState rows={2} />
        <ErrorDemo />
        <PartialNotice text="Some prices could not be checked, so they are not shown." />
      </Section>

      <Section id="buttons" title="Buttons">
        <p className="text-sm text-text-muted">
          One primary button per screen. Everything else is outline, secondary or ghost.
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <Button>Sign rules</Button>
          <Button variant="outline">Edit</Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="link">Link</Button>
          <Button variant="outline" disabled>
            Disabled
          </Button>
          <Button variant="outline" size="lg">
            Large
          </Button>
          <Button variant="outline" size="sm">
            Small
          </Button>
        </div>
      </Section>

      <Section id="inputs" title="Inputs">
        <div className="flex max-w-md flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="sg-email" className="text-sm font-medium text-text">
              Email
            </label>
            <Input id="sg-email" type="email" placeholder="you@example.com" />
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="sg-request" className="text-sm font-medium text-text">
              What should the agent buy?
            </label>
            <Textarea
              id="sg-request"
              defaultValue="Running shoes, size 10, under $70, only Stride Supply or Peak Outfitters, one pair, this week."
            />
          </div>
        </div>
      </Section>

      <Section id="primitives" title="Cards, tabs, badges, dialog, tooltip">
        <Card className="max-w-md">
          <CardHeader>
            <CardTitle>Hold waiting for you</CardTitle>
            <CardDescription>Trail Runner TR-2 at Peak Outfitters</CardDescription>
          </CardHeader>
          <CardContent className="flex items-center justify-between">
            <Money cents={6440} currency="USD" className="text-lg font-semibold" />
            <StateBadge state="held" />
          </CardContent>
          <CardFooter className="text-sm text-text-muted">
            Authorized on PayPal, not captured.
          </CardFooter>
        </Card>

        <Tabs defaultValue="activity" className="max-w-md">
          <TabsList>
            <TabsTrigger value="activity">Activity</TabsTrigger>
            <TabsTrigger value="rules">Rules</TabsTrigger>
          </TabsList>
          <TabsContent value="activity" className="text-text-muted">
            Recent purchases appear here.
          </TabsContent>
          <TabsContent value="rules" className="text-text-muted">
            Your signed rules appear here.
          </TabsContent>
        </Tabs>

        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="secondary">Secondary</Badge>
          <Badge variant="outline">Outline</Badge>
        </div>

        <Separator />

        <div className="flex flex-wrap items-center gap-3">
          <Dialog>
            <DialogTrigger asChild>
              <Button variant="outline">Open dialog</Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Approve this purchase?</DialogTitle>
                <DialogDescription>
                  Trail Runner TR-2 at Peak Outfitters for $64.40. PayPal captures it only if you
                  approve.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <DialogClose asChild>
                  <Button variant="outline">Not now</Button>
                </DialogClose>
                <Button>Approve</Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost">Hover for a tooltip</Button>
            </TooltipTrigger>
            <TooltipContent>
              Tooltips explain; they never hold the only copy of a fact.
            </TooltipContent>
          </Tooltip>
          <ToastDemo />
        </div>

        <div className="flex max-w-md flex-col gap-2" aria-hidden="true">
          <Skeleton className="h-4 w-3/5" />
          <Skeleton className="h-4 w-2/5" />
        </div>
      </Section>
    </main>
  );
}
