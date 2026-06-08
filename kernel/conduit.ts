import {
  type ApprovalRequest,
  ApprovalQueue,
  type Notifier,
} from './approval.ts';
import { AuditLog, type AuditEvent, type ChainVerification } from './audit.ts';
import { type Capability, type CapabilitySpec, CapabilityStore } from './capability.ts';
import { matchAction } from './match.ts';
import type { ConduitPersistence } from './persistence.ts';
import { PermissionEngine } from './permissions.ts';
import {
  type AgentRegistration,
  AgentRegistry,
  type RegisteredAgent,
  type RegistrationResult,
} from './registry.ts';
import type {
  AuthorizationDecision,
  AuthorizationRequest,
  PermissionRule,
} from './types.ts';

/** How long a human-approved action stays authorized before the grant lapses. */
const APPROVAL_GRANT_TTL_MS = 15 * 60 * 1000;

// ─────────────────────────────────────────────────────────────────────────────
// Conduit — the authorization kernel for AI agents.
//
// One object an agent harness wraps every tool call through. It answers a
// single question — "may this agent take this action right now?" — by
// consulting two layers and recording the verdict:
//
//   1. Permission rules   — coarse, always-on policy (allow / deny / ask).
//   2. Capability grants  — fine-grained, scoped, budgeted, expiring autonomy.
//
// Every decision and every executed action is written to a hash-chained audit
// log, so what an agent was allowed to do — and did — is always provable.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The policy governing self-service capability requests. A request that fits
 * entirely inside these bounds is granted programmatically — no human. A
 * request that exceeds them (or targets an un-listed action) is parked for
 * human approval. Omit `selfServe` entirely and *every* request needs a human.
 */
export type SelfServePolicy = {
  /** Glob patterns an agent may obtain a capability for without human review. */
  autoApproveActions?: readonly string[];
  /** A self-served capability's budget limit may not exceed this. */
  maxBudget?: number;
  /** A self-served capability's `maxInvocations` may not exceed this. */
  maxInvocations?: number;
};

export type ConduitConfig = {
  rules?: readonly PermissionRule[];
  /** Verdict when no rule matches and no capability covers the action. */
  defaultBehavior?: 'deny' | 'ask';
  /**
   * Durable storage for the audit log and capability grants. When provided,
   * prior state is restored on construction and every mutation is persisted.
   * Omit for an ephemeral, in-memory kernel (tests, demos).
   */
  persistence?: ConduitPersistence;
  /** Channel notified when an action needs human approval (`ask`). */
  notifier?: Notifier;
  /** Bounds for programmatic, human-free capability requests. */
  selfServe?: SelfServePolicy;
};

export type RunResult<T> =
  | { status: 'allowed'; decision: AuthorizationDecision; result: T }
  | { status: 'denied'; decision: AuthorizationDecision }
  | { status: 'needs_approval'; decision: AuthorizationDecision; approvalId: string };

/** The outcome of an agent's self-service capability request. */
export type CapabilityRequestResult =
  | { status: 'granted'; capability: Capability }
  | { status: 'pending'; approvalId: string }
  | { status: 'rejected'; reason: string };

/** What an agent passes to `requestCapability` — its identity is supplied separately. */
export type CapabilityRequest = Omit<CapabilitySpec, 'agentId' | 'grantedBy'>;

export class Conduit {
  private permissions: PermissionEngine;
  private readonly capabilities: CapabilityStore;
  private readonly audit: AuditLog;
  private readonly approvals = new ApprovalQueue();
  private readonly registry: AgentRegistry;
  private readonly notifier?: Notifier;
  private readonly defaultBehavior: 'deny' | 'ask';
  private readonly selfServe?: SelfServePolicy;

  constructor(config: ConduitConfig = {}) {
    this.permissions = new PermissionEngine(config.rules ?? []);
    this.defaultBehavior = config.defaultBehavior ?? 'ask';
    this.notifier = config.notifier;
    this.selfServe = config.selfServe;

    const store = config.persistence;
    this.audit = new AuditLog({
      initial: store?.loadEvents(),
      onAppend: store ? (event) => store.appendEvent(event) : undefined,
    });
    this.capabilities = new CapabilityStore({
      initialCapabilities: store?.loadCapabilities(),
      initialUsage: store?.loadUsage(),
      onCapabilityChange: store ? (cap) => store.upsertCapability(cap) : undefined,
      onUsageChange: store ? (id, usage) => store.saveUsage(id, usage) : undefined,
    });
    this.registry = new AgentRegistry({
      initialAgents: store?.loadAgents(),
      onAgentChange: store ? (agent) => store.upsertAgent(agent) : undefined,
    });
  }

  /**
   * Rule on a single action. Records the verdict to the audit log and returns
   * it. Does not execute anything — see `run` for authorize-then-execute.
   */
  authorize(request: AuthorizationRequest): AuthorizationDecision {
    const decision = this.decide(request);
    this.audit.append('authorize', request.agentId, {
      action: request.action,
      cost: request.cost ?? null,
      decision,
    });
    return decision;
  }

  /**
   * Authorize, then execute `execute` only if the verdict is `allow`.
   * On success, records the invocation and decrements any capability usage.
   * `deny` and `ask` short-circuit — `ask` returns `needs_approval` for the
   * caller to route to a human.
   */
  async run<T>(
    request: AuthorizationRequest,
    execute: () => Promise<T>,
  ): Promise<RunResult<T>> {
    const decision = this.authorize(request);
    if (decision.behavior === 'deny') return { status: 'denied', decision };
    if (decision.behavior === 'ask') {
      const approval = this.approvals.submit(request, decision.reason);
      await this.notifier?.notify(approval);
      return { status: 'needs_approval', decision, approvalId: approval.id };
    }

    const result = await execute();
    if (decision.capabilityId) {
      this.capabilities.recordUse(decision.capabilityId, request);
    }
    this.audit.append('invoke', request.agentId, {
      action: request.action,
      cost: request.cost ?? null,
      via: decision.via,
    });
    return { status: 'allowed', decision, result };
  }

  /** Issue a scoped capability to an agent. Recorded in the audit log. */
  grant(spec: CapabilitySpec): Capability {
    const capability = this.capabilities.grant(spec);
    this.audit.append('grant', capability.agentId, {
      capabilityId: capability.id,
      action: capability.action,
      constraints: capability.constraints,
      grantedBy: capability.grantedBy,
      expiresAt: capability.expiresAt,
    });
    return capability;
  }

  /** Revoke a capability. Returns false if unknown or already revoked. */
  revoke(capabilityId: string): boolean {
    const capability = this.capabilities.get(capabilityId);
    const ok = this.capabilities.revoke(capabilityId);
    if (ok && capability) {
      this.audit.append('revoke', capability.agentId, { capabilityId });
    }
    return ok;
  }

  /**
   * Register an agent and issue its token — the human-free sign-up step.
   * The plaintext token is returned exactly once; only its hash is retained.
   */
  registerAgent(registration: AgentRegistration): RegistrationResult {
    const result = this.registry.register(registration);
    this.audit.append('register', result.agent.agentId, {
      label: result.agent.label,
      metadata: result.agent.metadata,
    });
    return result;
  }

  /**
   * An agent's self-service request for a capability. The agent authenticates
   * with its token; the kernel then either grants the capability outright (if
   * it fits the self-serve policy), parks it for human approval, or rejects it.
   * This is what lets an agent sign up and start acting without a human.
   */
  requestCapability(
    agentId: string,
    token: string,
    request: CapabilityRequest,
  ): CapabilityRequestResult {
    if (!this.registry.authenticate(agentId, token)) {
      return { status: 'rejected', reason: 'authentication failed' };
    }

    const spec: CapabilitySpec = { ...request, agentId, grantedBy: 'policy:self-serve' };

    if (this.permissions.evaluate(spec.action)?.behavior === 'deny') {
      this.audit.append('request', agentId, { action: spec.action, outcome: 'rejected' });
      return { status: 'rejected', reason: `action "${spec.action}" is denied by policy` };
    }

    if (this.fitsSelfServePolicy(spec)) {
      const capability = this.grant(spec);
      this.audit.append('request', agentId, {
        action: spec.action,
        outcome: 'granted',
        capabilityId: capability.id,
      });
      return { status: 'granted', capability };
    }

    const approval = this.approvals.submit(
      { agentId, action: spec.action, input: {} },
      'self-service capability request exceeds the auto-approve policy',
      spec,
    );
    this.audit.append('request', agentId, {
      action: spec.action,
      outcome: 'pending',
      approvalId: approval.id,
    });
    void this.notifier?.notify(approval);
    return { status: 'pending', approvalId: approval.id };
  }

  /** A registered agent, or undefined. The token hash is included — never the token. */
  registeredAgent(agentId: string): RegisteredAgent | undefined {
    return this.registry.get(agentId);
  }

  /** All registered agents. */
  agents(): RegisteredAgent[] {
    return this.registry.list();
  }

  /** Pending approvals awaiting a human decision. */
  pendingApprovals(): ApprovalRequest[] {
    return this.approvals.list('pending');
  }

  /** Look up a single approval by id, regardless of status. */
  getApproval(id: string): ApprovalRequest | undefined {
    return this.approvals.get(id);
  }

  /**
   * Approve a pending request. Records the approval and issues a one-shot,
   * short-lived capability scoped to exactly that action — so when the agent
   * retries, the kernel allows it via capability. Returns null if the id is
   * unknown or already resolved.
   */
  approveRequest(id: string, approvedBy: string): ApprovalRequest | null {
    const approval = this.approvals.resolve(id, 'approved', approvedBy);
    if (!approval) return null;

    this.audit.append('approve', approval.agentId, {
      approvalId: approval.id,
      action: approval.action,
      approvedBy,
    });
    // A self-service capability request issues exactly the capability that was
    // asked for; a one-off `ask` issues a one-shot grant scoped to the action.
    this.grant(
      approval.requestedCapability
        ? { ...approval.requestedCapability, grantedBy: `approval:${approvedBy}` }
        : {
            agentId: approval.agentId,
            action: approval.action,
            constraints: {
              maxInvocations: 1,
              budget: approval.cost
                ? { currency: approval.cost.currency, limit: approval.cost.amount }
                : undefined,
            },
            grantedBy: `approval:${approvedBy}`,
            expiresAt: Date.now() + APPROVAL_GRANT_TTL_MS,
          },
    );
    return approval;
  }

  /** Reject a pending request. Records the rejection; no capability is issued. */
  rejectRequest(id: string, rejectedBy: string): ApprovalRequest | null {
    const approval = this.approvals.resolve(id, 'rejected', rejectedBy);
    if (!approval) return null;
    this.audit.append('reject', approval.agentId, {
      approvalId: approval.id,
      action: approval.action,
      rejectedBy,
    });
    return approval;
  }

  /** Add a permission rule at runtime — used by the control plane to manage policy. */
  addRule(rule: PermissionRule): void {
    this.permissions = this.permissions.withRule(rule);
  }

  /** The current policy rule set. */
  rules(): readonly PermissionRule[] {
    return this.permissions.list();
  }

  capabilitiesFor(agentId: string): Capability[] {
    return this.capabilities.listFor(agentId);
  }

  auditEntries(): readonly AuditEvent[] {
    return this.audit.entries();
  }

  verifyAudit(): ChainVerification {
    return this.audit.verify();
  }

  /** True only if a self-service request fits entirely inside the self-serve policy. */
  private fitsSelfServePolicy(spec: CapabilitySpec): boolean {
    const policy = this.selfServe;
    if (!policy?.autoApproveActions) return false;

    const actionAllowed = policy.autoApproveActions.some((pattern) =>
      matchAction(pattern, spec.action),
    );
    if (!actionAllowed) return false;

    const budgetLimit = spec.constraints?.budget?.limit;
    if (
      budgetLimit !== undefined &&
      policy.maxBudget !== undefined &&
      budgetLimit > policy.maxBudget
    ) {
      return false;
    }

    const invocations = spec.constraints?.maxInvocations;
    if (
      policy.maxInvocations !== undefined &&
      (invocations === undefined || invocations > policy.maxInvocations)
    ) {
      return false;
    }

    return true;
  }

  private decide(request: AuthorizationRequest): AuthorizationDecision {
    const rule = this.permissions.evaluate(request.action);

    if (rule?.behavior === 'deny') {
      return { behavior: 'deny', reason: rule.rule.note ?? `denied by rule "${rule.rule.action}"` };
    }

    if (rule?.behavior === 'allow') {
      return {
        behavior: 'allow',
        via: 'rule',
        detail: rule.rule.note ?? `allowed by rule "${rule.rule.action}"`,
      };
    }

    // No rule, or an `ask` rule: a capability can pre-authorize the action.
    const cap = this.capabilities.check(request);
    if (cap.covered) {
      return {
        behavior: 'allow',
        via: 'capability',
        detail: `covered by capability ${cap.capability.id}`,
        capabilityId: cap.capability.id,
      };
    }

    const base = rule?.behavior ?? this.defaultBehavior;
    return base === 'ask'
      ? { behavior: 'ask', reason: cap.reason }
      : { behavior: 'deny', reason: cap.reason };
  }
}
