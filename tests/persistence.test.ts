import { describe, expect, test } from 'bun:test';
import { Conduit } from '../kernel/conduit.ts';
import { SqlitePersistence } from '../kernel/persistence.ts';
import type { AuthorizationRequest } from '../kernel/types.ts';

const charge: AuthorizationRequest = {
  agentId: 'agent.a',
  action: 'payment.charge',
  input: {},
  cost: { currency: 'USD', amount: 40 },
};

describe('SqlitePersistence + Conduit', () => {
  test('audit events and capabilities survive a kernel restart', async () => {
    const store = new SqlitePersistence(':memory:');

    // Session 1: grant a capability and spend against it.
    const first = new Conduit({ persistence: store, rules: [{ action: 'payment.*', behavior: 'ask' }] });
    first.grant({
      agentId: 'agent.a',
      action: 'payment.*',
      constraints: { budget: { currency: 'USD', limit: 100 } },
      grantedBy: 'user',
    });
    await first.run(charge, async () => 'ok');
    const eventsBefore = first.auditEntries().length;

    // Session 2: a new kernel over the same store restores everything.
    const second = new Conduit({ persistence: store, rules: [{ action: 'payment.*', behavior: 'ask' }] });
    expect(second.auditEntries().length).toBe(eventsBefore);
    expect(second.capabilitiesFor('agent.a')).toHaveLength(1);
    expect(second.verifyAudit().valid).toBe(true);

    store.close();
  });

  test('spent budget is remembered across a restart', async () => {
    const store = new SqlitePersistence(':memory:');

    const first = new Conduit({ persistence: store, rules: [{ action: 'payment.*', behavior: 'ask' }] });
    first.grant({
      agentId: 'agent.a',
      action: 'payment.*',
      constraints: { budget: { currency: 'USD', limit: 50 } },
      grantedBy: 'user',
    });
    await first.run(charge, async () => 'ok'); // spends 40 of 50

    // After restart, only 10 of the budget remains — a 40 charge must escalate.
    const second = new Conduit({ persistence: store, rules: [{ action: 'payment.*', behavior: 'ask' }] });
    const outcome = await second.run(charge, async () => 'ok');
    expect(outcome.status).toBe('needs_approval');

    store.close();
  });

  test('a registered agent and its token survive a restart', () => {
    const store = new SqlitePersistence(':memory:');

    const first = new Conduit({ persistence: store });
    const { token } = first.registerAgent({ agentId: 'agent.a', label: 'Shopper' });

    // A fresh kernel over the same store still authenticates the same token.
    const second = new Conduit({ persistence: store });
    expect(second.registeredAgent('agent.a')?.label).toBe('Shopper');
    const result = second.requestCapability('agent.a', token, { action: 'web.search' });
    expect(result.status).not.toBe('rejected');

    store.close();
  });

  test('a rate-limited capability remembers its window across a restart', async () => {
    const store = new SqlitePersistence(':memory:');

    const first = new Conduit({ persistence: store, rules: [{ action: 'web.*', behavior: 'ask' }] });
    first.grant({
      agentId: 'agent.a',
      action: 'web.*',
      constraints: { rateLimit: { maxInvocations: 1, windowMs: 60_000 } },
      grantedBy: 'user',
    });
    await first.run({ agentId: 'agent.a', action: 'web.search', input: {} }, async () => 'x');

    // After restart the recent-use timestamp is restored — a second call is rate limited.
    const second = new Conduit({ persistence: store, rules: [{ action: 'web.*', behavior: 'ask' }] });
    const outcome = await second.run(
      { agentId: 'agent.a', action: 'web.search', input: {} },
      async () => 'y',
    );
    expect(outcome.status).toBe('needs_approval');

    store.close();
  });

  test('the restored audit chain continues unbroken', async () => {
    const store = new SqlitePersistence(':memory:');
    const first = new Conduit({ persistence: store, rules: [{ action: 'web.*', behavior: 'allow' }] });
    await first.run({ agentId: 'agent.a', action: 'web.search', input: {} }, async () => 'x');

    const second = new Conduit({ persistence: store, rules: [{ action: 'web.*', behavior: 'allow' }] });
    await second.run({ agentId: 'agent.a', action: 'web.search', input: {} }, async () => 'y');
    expect(second.verifyAudit().valid).toBe(true);

    store.close();
  });
});
