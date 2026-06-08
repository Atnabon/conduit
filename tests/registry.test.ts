import { describe, expect, test } from 'bun:test';
import { AgentRegistry } from '../kernel/registry.ts';
import { Conduit } from '../kernel/conduit.ts';

describe('AgentRegistry', () => {
  test('register issues a token and authenticates it', () => {
    const registry = new AgentRegistry();
    const { agent, token } = registry.register({ agentId: 'agent.a' });
    expect(token).toMatch(/^agt_/);
    expect(agent.tokenHash).not.toBe(token); // only the hash is stored
    expect(registry.authenticate('agent.a', token)).toBe(true);
  });

  test('a wrong token does not authenticate', () => {
    const registry = new AgentRegistry();
    registry.register({ agentId: 'agent.a' });
    expect(registry.authenticate('agent.a', 'agt_wrong')).toBe(false);
  });

  test('an unknown agent never authenticates', () => {
    const registry = new AgentRegistry();
    expect(registry.authenticate('agent.ghost', 'agt_anything')).toBe(false);
  });

  test('re-registering an existing id throws', () => {
    const registry = new AgentRegistry();
    registry.register({ agentId: 'agent.a' });
    expect(() => registry.register({ agentId: 'agent.a' })).toThrow();
  });
});

describe('Conduit self-service onboarding', () => {
  function selfServeConduit(): Conduit {
    return new Conduit({
      rules: [
        { action: 'web.*', behavior: 'allow' },
        { action: 'system.*', behavior: 'deny' },
        { action: 'payment.*', behavior: 'ask' },
      ],
      selfServe: {
        autoApproveActions: ['web.*', 'payment.*'],
        maxBudget: 50,
        maxInvocations: 5,
      },
    });
  }

  test('an agent registers and self-serves a capability within policy', async () => {
    const conduit = selfServeConduit();
    const { token } = conduit.registerAgent({ agentId: 'agent.a', label: 'Shopper' });

    const result = conduit.requestCapability('agent.a', token, {
      action: 'payment.charge',
      constraints: { budget: { currency: 'USD', limit: 40 }, maxInvocations: 3 },
    });
    expect(result.status).toBe('granted');

    // the granted capability actually authorizes the action
    const outcome = await conduit.run(
      { agentId: 'agent.a', action: 'payment.charge', input: {}, cost: { currency: 'USD', amount: 40 } },
      async () => 'charged',
    );
    expect(outcome.status).toBe('allowed');
  });

  test('a bad token is rejected', () => {
    const conduit = selfServeConduit();
    conduit.registerAgent({ agentId: 'agent.a' });
    const result = conduit.requestCapability('agent.a', 'agt_bad', { action: 'web.search' });
    expect(result.status).toBe('rejected');
  });

  test('a denied action cannot be self-served', () => {
    const conduit = selfServeConduit();
    const { token } = conduit.registerAgent({ agentId: 'agent.a' });
    const result = conduit.requestCapability('agent.a', token, { action: 'system.exec' });
    expect(result.status).toBe('rejected');
  });

  test('a request exceeding the policy is parked for human approval', () => {
    const conduit = selfServeConduit();
    const { token } = conduit.registerAgent({ agentId: 'agent.a' });

    const result = conduit.requestCapability('agent.a', token, {
      action: 'payment.charge',
      constraints: { budget: { currency: 'USD', limit: 500 }, maxInvocations: 3 }, // over maxBudget
    });
    expect(result.status).toBe('pending');

    if (result.status === 'pending') {
      conduit.approveRequest(result.approvalId, 'user.alice');
      const caps = conduit.capabilitiesFor('agent.a');
      // the approved capability carries the *requested* budget, not a one-shot default
      expect(caps.some((c) => c.constraints.budget?.limit === 500)).toBe(true);
    }
  });

  test('register and request are written to the audit log', () => {
    const conduit = selfServeConduit();
    const { token } = conduit.registerAgent({ agentId: 'agent.a' });
    conduit.requestCapability('agent.a', token, { action: 'web.search' });

    const types = conduit.auditEntries().map((e) => e.type);
    expect(types).toContain('register');
    expect(types).toContain('request');
  });

  test('with no self-serve policy every request needs a human', () => {
    const conduit = new Conduit({ rules: [{ action: 'web.*', behavior: 'allow' }] });
    const { token } = conduit.registerAgent({ agentId: 'agent.a' });
    const result = conduit.requestCapability('agent.a', token, { action: 'web.search' });
    expect(result.status).toBe('pending');
  });
});
