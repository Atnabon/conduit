import { describe, expect, test } from 'bun:test';
import { matchAction, specificity } from '../kernel/match.ts';
import { PermissionEngine } from '../kernel/permissions.ts';

describe('matchAction', () => {
  test('matches literal actions', () => {
    expect(matchAction('payment.charge', 'payment.charge')).toBe(true);
    expect(matchAction('payment.charge', 'payment.refund')).toBe(false);
  });

  test('* spans dotted segments', () => {
    expect(matchAction('payment.*', 'payment.charge')).toBe(true);
    expect(matchAction('payment.*', 'payment.refund.partial')).toBe(true);
    expect(matchAction('*', 'anything.at.all')).toBe(true);
  });

  test('is anchored to the whole string', () => {
    expect(matchAction('payment', 'payment.charge')).toBe(false);
  });

  test('specificity counts literal characters', () => {
    expect(specificity('payment.charge')).toBeGreaterThan(specificity('payment.*'));
  });
});

describe('PermissionEngine', () => {
  test('returns null when no rule matches', () => {
    expect(new PermissionEngine().evaluate('anything')).toBeNull();
  });

  test('matches a single rule', () => {
    const engine = new PermissionEngine([{ action: 'web.*', behavior: 'allow' }]);
    expect(engine.evaluate('web.search')?.behavior).toBe('allow');
  });

  test('deny always wins over allow', () => {
    const engine = new PermissionEngine([
      { action: 'payment.*', behavior: 'allow' },
      { action: 'payment.charge', behavior: 'deny' },
    ]);
    expect(engine.evaluate('payment.charge')?.behavior).toBe('deny');
  });

  test('higher priority wins among non-deny matches', () => {
    const engine = new PermissionEngine([
      { action: 'web.*', behavior: 'ask', priority: 0 },
      { action: 'web.*', behavior: 'allow', priority: 10 },
    ]);
    expect(engine.evaluate('web.search')?.behavior).toBe('allow');
  });

  test('more specific pattern wins on equal priority', () => {
    const engine = new PermissionEngine([
      { action: '*', behavior: 'ask' },
      { action: 'web.search', behavior: 'allow' },
    ]);
    expect(engine.evaluate('web.search')?.behavior).toBe('allow');
  });

  test('withRule does not mutate the original engine', () => {
    const base = new PermissionEngine();
    const extended = base.withRule({ action: 'web.*', behavior: 'allow' });
    expect(base.evaluate('web.search')).toBeNull();
    expect(extended.evaluate('web.search')?.behavior).toBe('allow');
  });
});
