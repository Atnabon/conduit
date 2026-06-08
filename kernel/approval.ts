import { randomUUID } from 'node:crypto';
import type { CapabilitySpec } from './capability.ts';
import type { AuthorizationRequest } from './types.ts';

// ─────────────────────────────────────────────────────────────────────────────
// Approval flow — the human-in-the-loop layer.
//
// When the kernel returns `ask`, the action is parked here as a pending
// `ApprovalRequest` and a human is notified. The human approves or rejects;
// an approval becomes a one-shot capability so the agent's retry succeeds.
// ─────────────────────────────────────────────────────────────────────────────

export type ApprovalStatus = 'pending' | 'approved' | 'rejected';

export type ApprovalRequest = {
  id: string;
  agentId: string;
  action: string;
  input: Readonly<Record<string, unknown>>;
  cost?: { currency: string; amount: number };
  reason: string;
  status: ApprovalStatus;
  createdAt: number;
  resolvedAt: number | null;
  resolvedBy: string | null;
  /**
   * Set when the approval is a self-service *capability request* rather than a
   * one-off action. On approval the kernel issues exactly this capability,
   * instead of the default one-shot grant scoped to the action.
   */
  requestedCapability?: CapabilitySpec;
};

/** A sink for approval notifications — a human-facing channel. */
export interface Notifier {
  notify(approval: ApprovalRequest): void | Promise<void>;
}

/** Writes a one-line notice to stderr. The default for local development. */
export class ConsoleNotifier implements Notifier {
  notify(approval: ApprovalRequest): void {
    process.stderr.write(
      `[conduit] approval needed: ${approval.agentId} → ${approval.action} ` +
        `(${approval.reason}) · id=${approval.id}\n`,
    );
  }
}

/**
 * POSTs a JSON message to a webhook URL. The body uses a `text` field, so a
 * Slack incoming-webhook URL works with no extra configuration.
 */
export class WebhookNotifier implements Notifier {
  constructor(private readonly url: string) {}

  async notify(approval: ApprovalRequest): Promise<void> {
    const text =
      `*conduit approval needed*\n` +
      `agent \`${approval.agentId}\` wants \`${approval.action}\`` +
      (approval.cost ? ` ($${approval.cost.amount} ${approval.cost.currency})` : '') +
      `\nreason: ${approval.reason}\napproval id: \`${approval.id}\``;
    try {
      await fetch(this.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text, approval }),
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`[conduit] webhook notify failed: ${message}\n`);
    }
  }
}

/**
 * The pending-approval store. Deduplicates: a second `ask` for the same
 * agent + action while one is still pending returns the existing request.
 */
export class ApprovalQueue {
  private readonly approvals = new Map<string, ApprovalRequest>();

  submit(
    request: AuthorizationRequest,
    reason: string,
    requestedCapability?: CapabilitySpec,
  ): ApprovalRequest {
    const existing = [...this.approvals.values()].find(
      (a) => a.status === 'pending' && a.agentId === request.agentId && a.action === request.action,
    );
    if (existing) return existing;

    const approval: ApprovalRequest = {
      id: `apr_${randomUUID()}`,
      agentId: request.agentId,
      action: request.action,
      input: request.input,
      cost: request.cost,
      reason,
      status: 'pending',
      createdAt: Date.now(),
      resolvedAt: null,
      resolvedBy: null,
      requestedCapability,
    };
    this.approvals.set(approval.id, approval);
    return approval;
  }

  resolve(
    id: string,
    status: 'approved' | 'rejected',
    resolvedBy: string,
  ): ApprovalRequest | null {
    const approval = this.approvals.get(id);
    if (!approval || approval.status !== 'pending') return null;
    const resolved: ApprovalRequest = {
      ...approval,
      status,
      resolvedAt: Date.now(),
      resolvedBy,
    };
    this.approvals.set(id, resolved);
    return resolved;
  }

  get(id: string): ApprovalRequest | undefined {
    return this.approvals.get(id);
  }

  list(status?: ApprovalStatus): ApprovalRequest[] {
    const all = [...this.approvals.values()];
    return status ? all.filter((a) => a.status === status) : all;
  }
}
