/**
 * Glob matching for action patterns.
 *
 * `*` matches any run of characters (including dots), so `payment.*` matches
 * `payment.charge` and `payment.refund.partial`. All other characters are
 * matched literally. Patterns are anchored — they must match the whole string.
 */
export function matchAction(pattern: string, action: string): boolean {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`).test(action);
}

/**
 * Specificity score for a pattern — used to rank competing matches.
 * More literal (non-`*`) characters means a more specific pattern.
 */
export function specificity(pattern: string): number {
  return pattern.replace(/\*/g, '').length;
}
