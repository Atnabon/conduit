import { describe, expect, test } from 'bun:test';
import { Conduit } from '../kernel/conduit.ts';
import type { AuthorizationRequest } from '../kernel/types.ts';

function req(over: Partial<AuthorizationRequest> = {}): AuthorizationRequest {
  return { agentId: 'agent.a', action: 'web.search', input: {}, ...over };
}

describe('Conduit.authorize', () => {
  test('an allow rule permits the action', () => {
    const conduit = new Conduit({ rules: [{ action: 'web.*', behavior: 'allow' }] });
    expect(conduit.authorize(req()).behavior).toBe('allow');
  });

  test('a deny rule blocks the action even with a capability', () => {
    const conduit = new Conduit({ rules: [{ action: 'system.*', behavior: 'deny' }] });
    conduit.grant({ agentId: 'agent.a', action: 'system.*', constraints: {}, grantedBy: 'u' });
    expect(conduit.authorize(req({ action: 'system.exec' })).behavior).toBe('deny');
  });

  test('an ask rule with no capability escalates', () => {
    const conduit = new Conduit({ rules: [{ action: 'payment.*', behavior: 'ask' }] });
    expect(conduit.authorize(req({ action: 'payment.charge' })).behavior).toBe('ask');
  });

  test('a capability upgrades an ask rule to allow', () => {
    const conduit = new Conduit({ rules: [{ action: 'payment.*', behavior: 'ask' }] });
    conduit.grant({ agentId: 'agent.a', action: 'payment.*', constraints: {}, grantedBy: 'u' });
    const decision = conduit.authorize(req({ action: 'payment.charge' }));
    expect(decision.behavior).toBe('allow');
    if (decision.behavior === 'allow') expect(decision.via).toBe('capability');
  });

  test('defaultBehavior applies when nothing matches', () => {
    expect(new Conduit({ defaultBehavior: 'deny' }).authorize(req()).behavior).toBe('deny');
    expect(new Conduit({ defaultBehavior: 'ask' }).authorize(req()).behavior).toBe('ask');
  });

  test('every authorize call is written to the audit log', () => {
    const conduit = new Conduit({ rules: [{ action: 'web.*', behavior: 'allow' }] });
    conduit.authorize(req());
    expect(conduit.auditEntries().some((e) => e.type === 'authorize')).toBe(true);
  });
});

describe('Conduit.run', () => {
  test('executes and records an allowed action', async () => {
    const conduit = new Conduit({ rules: [{ action: 'web.*', behavior: 'allow' }] });
    const outcome = await conduit.run(req(), async () => 'done');
    expect(outcome.status).toBe('allowed');
    if (outcome.status === 'allowed') expect(outcome.result).toBe('done');
    expect(conduit.auditEntries().some((e) => e.type === 'invoke')).toBe(true);
  });

  test('does not execute a denied action', async () => {
    const conduit = new Conduit({ rules: [{ action: 'system.*', behavior: 'deny' }] });
    let ran = false;
    const outcome = await conduit.run(req({ action: 'system.exec' }), async () => {
      ran = true;
      return 'x';
    });
    expect(outcome.status).toBe('denied');
    expect(ran).toBe(false);
  });

  test('an ask verdict returns needs_approval without executing', async () => {
    const conduit = new Conduit({ rules: [{ action: 'payment.*', behavior: 'ask' }] });
    let ran = false;
    const outcome = await conduit.run(req({ action: 'payment.charge' }), async () => {
      ran = true;
      return 'x';
    });
    expect(outcome.status).toBe('needs_approval');
    expect(ran).toBe(false);
  });

  test('budget is consumed across runs until exhausted', async () => {
    const conduit = new Conduit({ rules: [{ action: 'payment.*', behavior: 'ask' }] });
    conduit.grant({
      agentId: 'agent.a',
      action: 'payment.charge',
      constraints: { budget: { currency: 'USD', limit: 100 } },
      grantedBy: 'u',
    });
    const charge = (amount: number): AuthorizationRequest =>
      req({ action: 'payment.charge', cost: { currency: 'USD', amount } });

    const first = await conduit.run(charge(70), async () => 'ok');
    expect(first.status).toBe('allowed');
    const second = await conduit.run(charge(70), async () => 'ok');
    expect(second.status).toBe('needs_approval');
  });

  test('revoking a capability removes autonomy immediately', async () => {
    const conduit = new Conduit({ rules: [{ action: 'payment.*', behavior: 'ask' }] });
    const cap = conduit.grant({
      agentId: 'agent.a',
      action: 'payment.*',
      constraints: {},
      grantedBy: 'u',
    });
    expect(conduit.authorize(req({ action: 'payment.charge' })).behavior).toBe('allow');
    conduit.revoke(cap.id);
    expect(conduit.authorize(req({ action: 'payment.charge' })).behavior).toBe('ask');
  });

  test('the audit chain stays valid through a full session', async () => {
    const conduit = new Conduit({ rules: [{ action: 'web.*', behavior: 'allow' }] });
    conduit.grant({ agentId: 'agent.a', action: 'payment.*', constraints: {}, grantedBy: 'u' });
    await conduit.run(req(), async () => 'a');
    await conduit.run(req({ action: 'payment.charge' }), async () => 'b');
    expect(conduit.verifyAudit().valid).toBe(true);
  });
});
