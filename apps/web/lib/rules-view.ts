import type { Enforcement, RuleCard } from '@twokey/core';
import { formatUSD } from '@twokey/core/money';

/** What the compile route (and the manual form) hands back for review before signing. */
export interface DraftView {
  draftId: string | null;
  card: RuleCard | null;
  enforcement: Enforcement;
  advisory: { key: string; value: string; label: string }[];
  warnings: string[];
  needsInput: string[];
}

export interface StoreOption {
  id: string;
  slug: string;
  displayName: string;
}

export interface RuleLineView {
  key: string;
  label: string;
  value: string;
  enforcement: 'enforced' | 'advisory' | 'default';
}

const fmtDate = (iso: string) =>
  new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(iso));

function window(hours: number): string {
  if (hours === 24) return 'day';
  if (hours === 168) return 'week';
  if (hours % 24 === 0) return `${hours / 24} days`;
  return hours === 1 ? 'hour' : `${hours} hours`;
}

function minutes(m: number): string {
  if (m % 1440 === 0) return m === 1440 ? '1 day' : `${m / 1440} days`;
  if (m % 60 === 0) return m === 60 ? '1 hour' : `${m / 60} hours`;
  return `${m} minutes`;
}

/** One line per rule, in the order a person reads them; advisory notes last. */
export function ruleLines(
  card: RuleCard,
  enforcement: Enforcement,
  stores: StoreOption[],
): RuleLineView[] {
  const how = (key: string): RuleLineView['enforcement'] => enforcement[key] ?? 'enforced';
  const names = card.allowedMerchantIds.map(
    (id) => stores.find((s) => s.id === id)?.displayName ?? 'Unknown store',
  );
  const lines: RuleLineView[] = [
    {
      key: 'allowedMerchantIds',
      label: 'Stores',
      value: names.join(' or '),
      enforcement: how('allowedMerchantIds'),
    },
    {
      key: 'perItemCapCents',
      label: 'Most per item',
      value: formatUSD(card.perItemCapCents),
      enforcement: how('perItemCapCents'),
    },
    {
      key: 'perOrderCapCents',
      label: 'Most per order',
      value: formatUSD(card.perOrderCapCents),
      enforcement: how('perOrderCapCents'),
    },
    {
      key: 'maxQtyPerOrder',
      label: 'Quantity per order',
      value: `Up to ${card.maxQtyPerOrder}`,
      enforcement: how('maxQtyPerOrder'),
    },
  ];
  if (card.allowedCategories?.length) {
    lines.push({
      key: 'allowedCategories',
      label: 'Categories',
      value: card.allowedCategories.map((c) => c.replace(/_/g, ' ')).join(', '),
      enforcement: how('allowedCategories'),
    });
  }
  lines.push(
    {
      key: 'frequency',
      label: 'How often',
      value: `Up to ${card.frequency.maxPurchases} ${card.frequency.maxPurchases === 1 ? 'purchase' : 'purchases'} per ${window(card.frequency.windowHours)}`,
      enforcement: how('frequency'),
    },
    {
      key: 'expiresAt',
      label: 'Rules end',
      value: fmtDate(card.expiresAt),
      enforcement: how('expiresAt'),
    },
    {
      key: 'holdTimeoutMinutes',
      label: 'Unusual prices wait for you',
      value: `${minutes(card.holdTimeoutMinutes)}, then cancelled`,
      enforcement: how('holdTimeoutMinutes'),
    },
  );
  for (const a of card.advisory) {
    lines.push({ key: a.key, label: a.label, value: a.value, enforcement: 'advisory' });
  }
  return lines;
}

/** "a price cap" -> the question shown inline when the compiler couldn't fill it. */
export function needsInputPrompt(item: string): string {
  if (item === 'a price cap')
    return 'What is the most one item may cost? Add it, e.g. "under $70".';
  if (item === 'at least one store') {
    return 'Which stores may the agent buy from? Name at least one of your stores.';
  }
  return `Please add ${item}.`;
}
