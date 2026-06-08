import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';

// ─────────────────────────────────────────────────────────────────────────────
// Agent registry — programmatic, human-free onboarding.
//
// "Software for Agents" means an agent must be able to discover a tool, sign
// up for it, and start using it without a human in the loop. The registry is
// that sign-up step: an agent registers itself, receives a secret token, and
// authenticates every later request with it. The token is never stored — only
// its SHA-256 hash is — so a leaked database cannot impersonate an agent.
// ─────────────────────────────────────────────────────────────────────────────

export const agentRegistrationSchema = z.object({
  /** Stable identifier the agent will present on every request. */
  agentId: z.string().min(1),
  /** Human-friendly label for dashboards and audit. */
  label: z.string().min(1).optional(),
  /** Free-form metadata — harness name, owner, version, etc. */
  metadata: z.record(z.string(), z.unknown()).default({}),
});

export type AgentRegistration = z.input<typeof agentRegistrationSchema>;

export type RegisteredAgent = {
  agentId: string;
  label: string | null;
  metadata: Readonly<Record<string, unknown>>;
  /** SHA-256 hex digest of the issued token. The token itself is not stored. */
  tokenHash: string;
  registeredAt: number;
};

/** The one moment the plaintext token is available — returned to the caller once. */
export type RegistrationResult = { agent: RegisteredAgent; token: string };

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export type AgentRegistryOptions = {
  /** Agents to restore on construction (e.g. loaded from persistence). */
  initialAgents?: readonly RegisteredAgent[];
  /** Called when an agent is registered — used to persist. */
  onAgentChange?: (agent: RegisteredAgent) => void;
};

/**
 * Holds registered agents keyed by id. Registration is idempotent-by-failure:
 * re-registering an existing id throws rather than silently re-issuing a token,
 * so an attacker cannot overwrite an agent's identity by guessing its id.
 */
export class AgentRegistry {
  private readonly agents = new Map<string, RegisteredAgent>();
  private readonly onAgentChange?: (agent: RegisteredAgent) => void;

  constructor(options: AgentRegistryOptions = {}) {
    for (const agent of options.initialAgents ?? []) {
      this.agents.set(agent.agentId, agent);
    }
    this.onAgentChange = options.onAgentChange;
  }

  /** Register a new agent and issue its token. Throws if the id is taken. */
  register(registration: AgentRegistration): RegistrationResult {
    const parsed = agentRegistrationSchema.parse(registration);
    if (this.agents.has(parsed.agentId)) {
      throw new Error(`agent "${parsed.agentId}" is already registered`);
    }
    const token = `agt_${randomUUID()}${randomUUID()}`.replace(/-/g, '');
    const agent: RegisteredAgent = {
      agentId: parsed.agentId,
      label: parsed.label ?? null,
      metadata: parsed.metadata,
      tokenHash: hashToken(token),
      registeredAt: Date.now(),
    };
    this.agents.set(agent.agentId, agent);
    this.onAgentChange?.(agent);
    return { agent, token };
  }

  /** True only if the token matches the one issued to `agentId` at registration. */
  authenticate(agentId: string, token: string): boolean {
    const agent = this.agents.get(agentId);
    if (!agent) return false;
    return agent.tokenHash === hashToken(token);
  }

  get(agentId: string): RegisteredAgent | undefined {
    return this.agents.get(agentId);
  }

  list(): RegisteredAgent[] {
    return [...this.agents.values()];
  }
}
