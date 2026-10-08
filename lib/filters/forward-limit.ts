import type { FilterRule, VacationForward } from '@/lib/jmap/sieve-types';

/*
 * A server lets one message trigger only so many redirects
 * (maxNumberRedirects, 1 for user scripts on Stalwart by default) and skips
 * the ones over that. The rules run in order, and a rule that stops ("Stop
 * processing", or the Stop action) ends the script for the messages it
 * matches: the forwards of the rules below it never add to its own. What
 * counts is the most forwards a single message can collect, not how many
 * forwards there are.
 */

type RuleForwards = Pick<FilterRule, 'enabled' | 'actions' | 'stopProcessing'>;

/** The forwards of a rule that run: those ahead of a Stop action. */
export function ruleForwards(rule: Pick<FilterRule, 'actions'>): number {
  let forwards = 0;
  for (const action of rule.actions) {
    if (action.type === 'stop') break;
    if (action.type === 'forward') forwards++;
  }
  return forwards;
}

/** The rule ends the script for the messages it matches. */
export function ruleStops(rule: Pick<FilterRule, 'actions' | 'stopProcessing'>): boolean {
  return rule.stopProcessing || rule.actions.some((action) => action.type === 'stop');
}

/** The most forwards one message can collect going through `rules`, in their order. */
export function worstCaseForwards(rules: RuleForwards[]): number {
  // From the rules so far that let the message go on.
  let open = 0;
  let worst = 0;
  for (const rule of rules) {
    if (!rule.enabled) continue;
    const forwards = ruleForwards(rule);
    if (ruleStops(rule)) worst = Math.max(worst, open + forwards);
    else open += forwards;
  }
  return Math.max(worst, open);
}

/**
 * For the rule at `index` of `rules` (in the order they run): the forwards a
 * message can have collected when it reaches the rule, and the most it can
 * still collect below it when the rule lets it go on. `replaces`: the rule
 * is at `index` already, rather than about to be put there.
 */
export function forwardsAround(
  rules: RuleForwards[],
  index: number,
  replaces: boolean,
): { before: number; after: number } {
  // A rule above that stops lets only the messages it does not match go on,
  // so its forwards never meet this rule's.
  const before = rules
    .slice(0, index)
    .filter((rule) => rule.enabled && !ruleStops(rule))
    .reduce((n, rule) => n + ruleForwards(rule), 0);
  const after = worstCaseForwards(rules.slice(replaces ? index + 1 : index));
  return { before, after };
}

/**
 * The rules in the order the script runs them: forwarding from the out of
 * office card goes ahead of every rule, and ends the script unless it keeps
 * a copy here.
 */
export function inRunOrder(rules: RuleForwards[], forward: VacationForward | null | undefined): RuleForwards[] {
  if (!forward?.enabled) return rules;
  return [{ enabled: true, actions: [{ type: 'forward', value: forward.to }], stopProcessing: !forward.keepCopy }, ...rules];
}
