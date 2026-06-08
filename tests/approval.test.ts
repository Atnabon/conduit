import { describe, expect, test } from 'bun:test';
import { ApprovalQueue, type Notifier, type ApprovalRequest } from '../kernel/approval.ts';
import { Conduit } from '../kernel/conduit.ts';
import type { AuthorizationRequest } from '../kernel/types.ts';

const charge: AuthorizationRequest = {
  agentId: 'agent.a',
  action: 'payment.charge',
  input: { vendor: 'Acme' },
  cost: { currency: 'USD', amount: 40 },
};

describe('ApprovalQueue', () => {
  test('submits a pending request', () => {
    const queue = new ApprovalQueue();
    const approval = queue.submit(charge, 'needs approval');
    expect(approval.status).toBe('pending');
    expect(queue.list('pending')).toHaveLength(1);
  });

  test('deduplicates a repeated agent+action while pending', () => {
    const queue = new ApprovalQueue();
    const first = queue.submit(charge, 'r');
    const second = queue.submit(charge, 'r');
    expect(second.id).toBe(first.id);
    expect(queue.list()).toHaveLength(1);
  });

  test('resolve transitions a pending request once', () => {
    const queue = new ApprovalQueue();
    const approval = queue.submit(charge, 'r');
    expect(queue.resolve(approval.id, 'approved', 'alice')?.status).toBe('approved');
    expect(queue.resolve(approval.id, 'rejected', 'bob')).toBeNull();
  });
});

describe('Conduit approval flow', () => {
  test('an ask verdict creates a pending approval', async () => {
    const conduit = new Conduit({ rules: [{ action: 'payment.*', behavior: 'ask' }] });
    const outcome = await conduit.run(charge, async () => 'charged');
    expect(outcome.status).toBe('needs_approval');
    if (outcome.status === 'needs_approval') {
      expect(conduit.getApproval(outcome.approvalId)?.status).toBe('pending');
    }
    expect(conduit.pendingApprovals()).toHaveLength(1);
  });

  test('approving issues a one-shot capability so the retry succeeds', async () => {
    const conduit = new Conduit({ rules: [{ action: 'payment.*', behavior: 'ask' }] });
    const first = await conduit.run(charge, async () => 'charged');
    expect(first.status).toBe('needs_approval');

    if (first.status !== 'needs_approval') throw new Error('expected needs_approval');
    conduit.approveRequest(first.approvalId, 'human.alice');

    const retry = await conduit.run(charge, async () => 'charged');
    expect(retry.status).toBe('allowed');

    // The one-shot capability is spent — a second retry asks again.
    const third = await conduit.run(charge, async () => 'charged');
    expect(third.status).toBe('needs_approval');
  });

  test('rejecting does not authorize the retry', async () => {
    const conduit = new Conduit({ rules: [{ action: 'payment.*', behavior: 'ask' }] });
    const first = await conduit.run(charge, async () => 'charged');
    if (first.status !== 'needs_approval') throw new Error('expected needs_approval');

    conduit.rejectRequest(first.approvalId, 'human.alice');
    const retry = await conduit.run(charge, async () => 'charged');
    expect(retry.status).toBe('needs_approval');
  });

  test('approve and reject are written to the audit log', async () => {
    const conduit = new Conduit({ rules: [{ action: 'payment.*', behavior: 'ask' }] });
    const first = await conduit.run(charge, async () => 'x');
    if (first.status !== 'needs_approval') throw new Error('expected needs_approval');
    conduit.approveRequest(first.approvalId, 'alice');
    expect(conduit.auditEntries().some((e) => e.type === 'approve')).toBe(true);
    expect(conduit.verifyAudit().valid).toBe(true);
  });

  test('the notifier is called when approval is needed', async () => {
    const seen: ApprovalRequest[] = [];
    const notifier: Notifier = { notify: (a) => void seen.push(a) };
    const conduit = new Conduit({ rules: [{ action: 'payment.*', behavior: 'ask' }], notifier });
    await conduit.run(charge, async () => 'x');
    expect(seen).toHaveLength(1);
    expect(seen[0].action).toBe('payment.charge');
  });

  test('resolving an unknown approval returns null', () => {
    const conduit = new Conduit();
    expect(conduit.approveRequest('apr_missing', 'alice')).toBeNull();
    expect(conduit.rejectRequest('apr_missing', 'alice')).toBeNull();
  });
});
