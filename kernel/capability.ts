import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { matchAction } from './match.ts';
import type { AuthorizationRequest } from './types.ts';

// ─────────────────────────────────────────────────────────────────────────────
// Capabilities — the fine-grained, scoped authorization layer.
//
// Where a permission rule says "this class of action is allowed", a capability
// says "*this agent* may perform *this action* up to *these limits* until
// *this time*". Capabilities are how an agent is trusted to act autonomously
// without a human in the loop — safely, because every limit is explicit.
// ─────────────────────────────────────────────────────────────────────────────

export const capabilitySpecSchema = z.object({
  agentId: z.string().min(1),
  /** Glob pattern matched against the request action, e.g. `payment.*`. */
  action: z.string().min(1),
  constraints: z
    .object({
      /** Maximum number of times this capability may authorize an action. */
      maxInvocations: z.number().int().positive().optional(),
      /** Total spend ceiling across all invocations of this capability. */
      budget: z
        .object({ currency: z.string().min(1), limit: z.number().nonnegative() })
        .optional(),
      /**
       * Velocity limit: at most `maxInvocations` uses within any `windowMs`
       * sliding window. A total budget cannot stop an agent from burning
       * everything in one second — a rate limit can.
       */
      rateLimit: z
        .object({
          maxInvocations: z.number().int().positive(),
          windowMs: z.number().int().positive(),
        })
        .optional(),
      /** Request input must equal these key/value pairs exactly. */
      paramEquals: z.record(z.string(), z.unknown()).optional(),
    })
    .default({}),
  /** Who authorized this grant — a human user id or a policy id. */
  grantedBy: z.string().min(1),
  /** Epoch ms after which the capability is invalid. `null` = never expires. */
  expiresAt: z.number().int().positive().nullable().default(null),
});

/** What a caller passes to `grant` — `constraints` and `expiresAt` are optional. */
export type CapabilitySpec = z.input<typeof capabilitySpecSchema>;

/** A fully-resolved capability spec, after schema defaults are applied. */
type ResolvedSpec = z.output<typeof capabilitySpecSchema>;

export type Capability = ResolvedSpec & {
  id: string;
  grantedAt: number;
  revokedAt: number | null;
};

export type Usage = {
  invocations: number;
  spent: number;
  /** Epoch ms of recent invocations, kept only within the rate-limit window. */
  recent: number[];
};

const emptyUsage = (): Usage => ({ invocations: 0, spent: 0, recent: [] });

export type CapabilityCheck =
  | { covered: true; capability: Capability }
  | { covered: false; reason: string };

export type CapabilityStoreOptions = {
  /** Capabilities to restore on construction (e.g. loaded from persistence). */
  initialCapabilities?: readonly Capability[];
  /** Usage ledger to restore on construction. */
  initialUsage?: ReadonlyMap<string, Usage>;
  /** Called when a capability is granted or revoked — used to persist. */
  onCapabilityChange?: (capability: Capability) => void;
  /** Called when a capability's usage changes — used to persist. */
  onUsageChange?: (capabilityId: string, usage: Usage) => void;
};

/**
 * Holds granted capabilities and their running usage. Capability records are
 * immutable once granted; revocation replaces the record with a copy carrying
 * `revokedAt`. Usage is a running ledger keyed by capability id. Optional
 * change hooks mirror every mutation to durable storage.
 */
export class CapabilityStore {
  private readonly capabilities = new Map<string, Capability>();
  private readonly usage = new Map<string, Usage>();
  private readonly onCapabilityChange?: (capability: Capability) => void;
  private readonly onUsageChange?: (capabilityId: string, usage: Usage) => void;

  constructor(options: CapabilityStoreOptions = {}) {
    for (const cap of options.initialCapabilities ?? []) {
      this.capabilities.set(cap.id, cap);
    }
    for (const [id, usage] of options.initialUsage ?? []) {
      this.usage.set(id, usage);
    }
    this.onCapabilityChange = options.onCapabilityChange;
    this.onUsageChange = options.onUsageChange;
  }

  grant(spec: CapabilitySpec): Capability {
    const parsed = capabilitySpecSchema.parse(spec);
    const capability: Capability = {
      ...parsed,
      id: `cap_${randomUUID()}`,
      grantedAt: Date.now(),
      revokedAt: null,
    };
    this.capabilities.set(capability.id, capability);
    const usage = emptyUsage();
    this.usage.set(capability.id, usage);
    this.onCapabilityChange?.(capability);
    this.onUsageChange?.(capability.id, usage);
    return capability;
  }

  revoke(id: string): boolean {
    const existing = this.capabilities.get(id);
    if (!existing || existing.revokedAt !== null) return false;
    const revoked: Capability = { ...existing, revokedAt: Date.now() };
    this.capabilities.set(id, revoked);
    this.onCapabilityChange?.(revoked);
    return true;
  }

  get(id: string): Capability | undefined {
    return this.capabilities.get(id);
  }

  listFor(agentId: string): Capability[] {
    return [...this.capabilities.values()].filter((c) => c.agentId === agentId);
  }

  /**
   * Find a live capability that covers `request` within all its constraints.
   * Returns the first match, or a reason describing why none qualified.
   */
  check(request: AuthorizationRequest, now: number = Date.now()): CapabilityCheck {
    const candidates = this.listFor(request.agentId).filter((c) =>
      matchAction(c.action, request.action),
    );
    if (candidates.length === 0) {
      return { covered: false, reason: `no capability grants action "${request.action}"` };
    }

    let lastReason = 'no capability satisfied all constraints';
    for (const cap of candidates) {
      const reason = this.disqualify(cap, request, now);
      if (reason === null) return { covered: true, capability: cap };
      lastReason = reason;
    }
    return { covered: false, reason: lastReason };
  }

  /** Record one use of a capability against the running usage ledger. */
  recordUse(
    capabilityId: string,
    request: AuthorizationRequest,
    now: number = Date.now(),
  ): void {
    const current = this.usage.get(capabilityId);
    if (!current) return;
    const windowMs = this.capabilities.get(capabilityId)?.constraints.rateLimit?.windowMs;
    const recent = windowMs
      ? [...current.recent, now].filter((t) => t > now - windowMs)
      : [];
    const next: Usage = {
      invocations: current.invocations + 1,
      spent: current.spent + (request.cost?.amount ?? 0),
      recent,
    };
    this.usage.set(capabilityId, next);
    this.onUsageChange?.(capabilityId, next);
  }

  /** Returns a disqualifying reason, or `null` if the capability fully covers the request. */
  private disqualify(
    cap: Capability,
    request: AuthorizationRequest,
    now: number,
  ): string | null {
    if (cap.revokedAt !== null) return `capability ${cap.id} was revoked`;
    if (cap.expiresAt !== null && now >= cap.expiresAt) {
      return `capability ${cap.id} expired`;
    }

    const used = this.usage.get(cap.id) ?? emptyUsage();
    const { maxInvocations, budget, rateLimit, paramEquals } = cap.constraints;

    if (maxInvocations !== undefined && used.invocations >= maxInvocations) {
      return `capability ${cap.id} exhausted (${maxInvocations} invocations used)`;
    }

    if (rateLimit) {
      const inWindow = used.recent.filter((t) => t > now - rateLimit.windowMs).length;
      if (inWindow >= rateLimit.maxInvocations) {
        return `capability ${cap.id} rate limited (${rateLimit.maxInvocations} per ${rateLimit.windowMs}ms)`;
      }
    }

    if (budget) {
      const amount = request.cost?.amount ?? 0;
      if (request.cost && request.cost.currency !== budget.currency) {
        return `cost currency ${request.cost.currency} ≠ budget currency ${budget.currency}`;
      }
      if (used.spent + amount > budget.limit) {
        return `capability ${cap.id} budget exceeded (${used.spent} + ${amount} > ${budget.limit})`;
      }
    }

    if (paramEquals) {
      for (const [key, expected] of Object.entries(paramEquals)) {
        if (request.input[key] !== expected) {
          return `param "${key}" must equal ${JSON.stringify(expected)}`;
        }
      }
    }

    return null;
  }
}
