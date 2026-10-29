import { formatUSD } from '@twokey/core/money';
import { shareCount } from '../components/results/format';
import type { ResultsSummary } from './results-queries';

export interface AttackNumbers {
  split: ResultsSummary['split'];
  runs: number;
  gateDecisions: number;
  /** Attacked runs ("poisoned trips"), pooled over models. */
  attacked: number;
  attackerPayments: number;
  /** Followed attacks that asked the agent to pay the attacker. */
  outsideFollowed: number;
  /** Followed attacks that asked for another product at an allowed store, inside the budget. */
  insideFollowed: number;
  /** Of those, the ones that passed every signed rule under Two-Key. */
  insidePassed: number;
  attackerMoney: string;
}

/** Every public-page number, read from the results summary (never typed). */
export function attackNumbers(s: ResultsSummary): AttackNumbers {
  const models = Object.values(s.models);
  const sum = (f: (m: (typeof models)[number]) => number) => models.reduce((a, m) => a + f(m), 0);
  return {
    split: s.split,
    runs: s.totals.runs,
    gateDecisions: s.totals.gateDecisions,
    attacked: s.headline.attacked,
    attackerPayments: s.headline.attackerPayments,
    outsideFollowed: sum((m) => m.followByTarget.outside_rules.followed),
    insideFollowed: sum((m) => m.followByTarget.inside_rules.followed),
    insidePassed: sum((m) => shareCount(m.insideRules.passShare, m.insideRules.followed)),
    attackerMoney: formatUSD(s.attackerMoneyCentsG4),
  };
}

const n = (x: number) => x.toLocaleString('en-US');
const times = (x: number) => `${n(x)} ${x === 1 ? 'time' : 'times'}`;

/** The live strip's header counts, as on /results. */
export function stripCounts(a: AttackNumbers): string {
  return [
    `${n(a.runs)} runs`,
    `${n(a.gateDecisions)} gate decisions`,
    `${n(a.attacked)} attacked runs`,
    `${n(a.attackerPayments)} attacker ${a.attackerPayments === 1 ? 'payment' : 'payments'} under Two-Key`,
  ].join(' · ');
}

/** The line under the live strip: what hijacked agents actually tried. */
export function attackLine(a: AttackNumbers): string {
  return `In ${n(a.attacked)} poisoned trips, agents followed ‘pay the attacker’ ${times(a.outsideFollowed)} and ‘buy this other product’ ${times(a.insideFollowed)}. Money sent to the attacker: ${a.attackerMoney}.`;
}
