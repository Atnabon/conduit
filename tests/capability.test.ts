import { describe, expect, test } from 'bun:test';
import { CapabilityStore } from '../kernel/capability.ts';
import type { AuthorizationRequest } from '../kernel/types.ts';

function request(over: Partial<AuthorizationRequest> = {}): AuthorizationRequest {
  return { agentId: 'agent.a', action: 'payment.charge', input: {}, ...over };
}

describe('CapabilityStore', () => {
  test('a fresh grant covers a matching action', () => {
    const store = new CapabilityStore();
    store.grant({ agentId: 'agent.a', action: 'payment.*', constraints: {}, grantedBy: 'user' });
    expect(store.check(request()).covered).toBe(true);
  });

  test('no capability for the action is not covered', () => {
    const store = new CapabilityStore();
    store.grant({ agentId: 'agent.a', action: 'web.*', constraints: {}, grantedBy: 'user' });
    expect(store.check(request()).covered).toBe(false);
  });

  test('a capability for another agent does not apply', () => {
    const store = new CapabilityStore();
    store.grant({ agentId: 'agent.b', action: 'payment.*', constraints: {}, grantedBy: 'user' });
    expect(store.check(request()).covered).toBe(false);
  });

  test('revoked capabilities stop covering', () => {
    const store = new CapabilityStore();
    const cap = store.grant({ agentId: 'agent.a', action: 'payment.*', constraints: {}, grantedBy: 'u' });
    expect(store.check(request()).covered).toBe(true);
    store.revoke(cap.id);
    expect(store.check(request()).covered).toBe(false);
  });

  test('expired capabilities stop covering', () => {
    const store = new CapabilityStore();
    store.grant({
      agentId: 'agent.a',
      action: 'payment.*',
      constraints: {},
      grantedBy: 'u',
      expiresAt: 1_000,
    });
    expect(store.check(request(), 2_000).covered).toBe(false);
  });

  test('maxInvocations is enforced via the usage ledger', () => {
    const store = new CapabilityStore();
    const cap = store.grant({
      agentId: 'agent.a',
      action: 'payment.*',
      constraints: { maxInvocations: 1 },
      grantedBy: 'u',
    });
    expect(store.check(request()).covered).toBe(true);
    store.recordUse(cap.id, request());
    expect(store.check(request()).covered).toBe(false);
  });

  test('budget blocks a request that would exceed the ceiling', () => {
    const store = new CapabilityStore();
    const cap = store.grant({
      agentId: 'agent.a',
      action: 'payment.*',
      constraints: { budget: { currency: 'USD', limit: 100 } },
      grantedBy: 'u',
    });
    const within = request({ cost: { currency: 'USD', amount: 60 } });
    expect(store.check(within).covered).toBe(true);
    store.recordUse(cap.id, within);
    expect(store.check(request({ cost: { currency: 'USD', amount: 60 } })).covered).toBe(false);
  });

  test('budget currency mismatch is rejected', () => {
    const store = new CapabilityStore();
    store.grant({
      agentId: 'agent.a',
      action: 'payment.*',
      constraints: { budget: { currency: 'USD', limit: 100 } },
      grantedBy: 'u',
    });
    expect(store.check(request({ cost: { currency: 'EUR', amount: 10 } })).covered).toBe(false);
  });

  test('paramEquals constrains the request input', () => {
    const store = new CapabilityStore();
    store.grant({
      agentId: 'agent.a',
      action: 'payment.*',
      constraints: { paramEquals: { vendor: 'Acme' } },
      grantedBy: 'u',
    });
    expect(store.check(request({ input: { vendor: 'Acme' } })).covered).toBe(true);
    expect(store.check(request({ input: { vendor: 'Globex' } })).covered).toBe(false);
  });

  test('rateLimit blocks a burst inside the window but recovers after it', () => {
    const store = new CapabilityStore();
    const cap = store.grant({
      agentId: 'agent.a',
      action: 'payment.*',
      constraints: { rateLimit: { maxInvocations: 2, windowMs: 1_000 } },
      grantedBy: 'u',
    });
    expect(store.check(request(), 10_000).covered).toBe(true);
    store.recordUse(cap.id, request(), 10_000);
    store.recordUse(cap.id, request(), 10_100);
    // third use inside the same 1s window is rate limited
    expect(store.check(request(), 10_200).covered).toBe(false);
    // once the window has slid past the earlier uses, it recovers
    expect(store.check(request(), 11_200).covered).toBe(true);
  });

  test('rejects an invalid spec', () => {
    const store = new CapabilityStore();
    expect(() =>
      store.grant({ agentId: '', action: 'x', constraints: {}, grantedBy: 'u' }),
    ).toThrow();
  });
});
