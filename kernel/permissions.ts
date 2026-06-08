import { matchAction, specificity } from './match.ts';
import type { PermissionBehavior, PermissionRule } from './types.ts';

/**
 * The result of evaluating permission rules against an action.
 * `null` means no rule matched — the kernel falls through to capabilities.
 */
export type RuleMatch = {
  behavior: PermissionBehavior;
  rule: PermissionRule;
} | null;

/**
 * The coarse policy layer. A flat, ordered set of glob rules that classify an
 * action as allow / deny / ask before any capability is considered.
 *
 * Resolution order for a given action:
 *   1. Any matching `deny` rule wins outright — deny is non-overridable.
 *   2. Otherwise the highest-priority matching rule wins.
 *   3. Ties broken by pattern specificity (more literal characters wins).
 *   4. No match → `null` (the kernel then checks capabilities).
 */
export class PermissionEngine {
  private readonly rules: readonly PermissionRule[];

  constructor(rules: readonly PermissionRule[] = []) {
    this.rules = rules;
  }

  /** Return a new engine with an additional rule — the rule set is immutable. */
  withRule(rule: PermissionRule): PermissionEngine {
    return new PermissionEngine([...this.rules, rule]);
  }

  /** The current rule set, for inspection (e.g. a control-plane dashboard). */
  list(): readonly PermissionRule[] {
    return this.rules;
  }

  evaluate(action: string): RuleMatch {
    const matches = this.rules.filter((r) => matchAction(r.action, action));
    if (matches.length === 0) return null;

    const deny = matches.find((r) => r.behavior === 'deny');
    if (deny) return { behavior: 'deny', rule: deny };

    const winner = [...matches].sort((a, b) => {
      const byPriority = (b.priority ?? 0) - (a.priority ?? 0);
      if (byPriority !== 0) return byPriority;
      return specificity(b.action) - specificity(a.action);
    })[0];

    return { behavior: winner.behavior, rule: winner };
  }
}
