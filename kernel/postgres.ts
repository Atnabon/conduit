import { SQL } from 'bun';
import type { AuditEvent, AuditEventType } from './audit.ts';
import type { Capability, Usage } from './capability.ts';
import type { ConduitPersistence } from './persistence.ts';
import type { RegisteredAgent } from './registry.ts';

// ─────────────────────────────────────────────────────────────────────────────
// Postgres persistence — the hosted-control-plane storage backend.
//
// Satisfies the same `ConduitPersistence` interface as `SqlitePersistence`, so
// the kernel is unchanged: local installs use SQLite, the hosted control plane
// uses Postgres. Uses Bun's native SQL client.
//
// Note: requires a reachable Postgres database. `init()` must be awaited once
// before the persistence is handed to a `Conduit` (the kernel's loads are
// synchronous, so the tables and the in-memory caches must be ready first).
// ─────────────────────────────────────────────────────────────────────────────

type EventRow = {
  seq: number;
  timestamp: string;
  type: string;
  agent_id: string;
  payload: unknown;
  prev_hash: string;
  hash: string;
};

type CapabilityRow = {
  id: string;
  agent_id: string;
  action: string;
  constraints: unknown;
  granted_by: string;
  granted_at: string;
  expires_at: string | null;
  revoked_at: string | null;
};

type UsageRow = {
  capability_id: string;
  invocations: number;
  spent: number;
  recent: unknown;
};

type AgentRow = {
  agent_id: string;
  label: string | null;
  metadata: unknown;
  token_hash: string;
  registered_at: string;
};

export class PostgresPersistence implements ConduitPersistence {
  private readonly sql: SQL;
  private events: AuditEvent[] = [];
  private capabilities: Capability[] = [];
  private usage = new Map<string, Usage>();
  private agents: RegisteredAgent[] = [];

  constructor(connectionString: string) {
    this.sql = new SQL(connectionString);
  }

  /**
   * Create tables if needed and warm the in-memory caches. Must be awaited
   * before this persistence is passed to a `Conduit`.
   */
  async init(): Promise<void> {
    await this.sql`
      CREATE TABLE IF NOT EXISTS conduit_events (
        seq BIGINT PRIMARY KEY,
        timestamp BIGINT NOT NULL,
        type TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        payload JSONB NOT NULL,
        prev_hash TEXT NOT NULL,
        hash TEXT NOT NULL
      )`;
    await this.sql`
      CREATE TABLE IF NOT EXISTS conduit_capabilities (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        action TEXT NOT NULL,
        constraints JSONB NOT NULL,
        granted_by TEXT NOT NULL,
        granted_at BIGINT NOT NULL,
        expires_at BIGINT,
        revoked_at BIGINT
      )`;
    await this.sql`
      CREATE TABLE IF NOT EXISTS conduit_usage (
        capability_id TEXT PRIMARY KEY,
        invocations INTEGER NOT NULL,
        spent DOUBLE PRECISION NOT NULL,
        recent JSONB NOT NULL DEFAULT '[]'::jsonb
      )`;
    await this.sql`
      ALTER TABLE conduit_usage
      ADD COLUMN IF NOT EXISTS recent JSONB NOT NULL DEFAULT '[]'::jsonb`;
    await this.sql`
      CREATE TABLE IF NOT EXISTS conduit_agents (
        agent_id TEXT PRIMARY KEY,
        label TEXT,
        metadata JSONB NOT NULL,
        token_hash TEXT NOT NULL,
        registered_at BIGINT NOT NULL
      )`;

    const events = (await this.sql`
      SELECT * FROM conduit_events ORDER BY seq ASC`) as EventRow[];
    this.events = events.map((r) => ({
      seq: Number(r.seq),
      timestamp: Number(r.timestamp),
      type: r.type as AuditEventType,
      agentId: r.agent_id,
      payload: r.payload as Record<string, unknown>,
      prevHash: r.prev_hash,
      hash: r.hash,
    }));

    const caps = (await this.sql`SELECT * FROM conduit_capabilities`) as CapabilityRow[];
    this.capabilities = caps.map((r) => ({
      id: r.id,
      agentId: r.agent_id,
      action: r.action,
      constraints: r.constraints as Capability['constraints'],
      grantedBy: r.granted_by,
      grantedAt: Number(r.granted_at),
      expiresAt: r.expires_at === null ? null : Number(r.expires_at),
      revokedAt: r.revoked_at === null ? null : Number(r.revoked_at),
    }));

    const usage = (await this.sql`SELECT * FROM conduit_usage`) as UsageRow[];
    this.usage = new Map(
      usage.map((r) => [
        r.capability_id,
        { invocations: r.invocations, spent: r.spent, recent: (r.recent as number[]) ?? [] },
      ]),
    );

    const agents = (await this.sql`SELECT * FROM conduit_agents`) as AgentRow[];
    this.agents = agents.map((r) => ({
      agentId: r.agent_id,
      label: r.label,
      metadata: r.metadata as Record<string, unknown>,
      tokenHash: r.token_hash,
      registeredAt: Number(r.registered_at),
    }));
  }

  // ConduitPersistence — synchronous reads served from the warmed caches.

  loadEvents(): AuditEvent[] {
    return this.events;
  }

  loadCapabilities(): Capability[] {
    return this.capabilities;
  }

  loadUsage(): Map<string, Usage> {
    return this.usage;
  }

  loadAgents(): RegisteredAgent[] {
    return this.agents;
  }

  // Writes are fire-and-forget — the kernel's mutators are synchronous; the
  // in-memory state is authoritative, Postgres is the durable mirror.

  appendEvent(event: AuditEvent): void {
    void this.sql`
      INSERT INTO conduit_events (seq, timestamp, type, agent_id, payload, prev_hash, hash)
      VALUES (${event.seq}, ${event.timestamp}, ${event.type}, ${event.agentId},
              ${JSON.stringify(event.payload)}::jsonb, ${event.prevHash}, ${event.hash})
    `.catch((error: unknown) => this.warn('appendEvent', error));
  }

  upsertCapability(capability: Capability): void {
    void this.sql`
      INSERT INTO conduit_capabilities
        (id, agent_id, action, constraints, granted_by, granted_at, expires_at, revoked_at)
      VALUES (${capability.id}, ${capability.agentId}, ${capability.action},
              ${JSON.stringify(capability.constraints)}::jsonb, ${capability.grantedBy},
              ${capability.grantedAt}, ${capability.expiresAt}, ${capability.revokedAt})
      ON CONFLICT (id) DO UPDATE SET revoked_at = EXCLUDED.revoked_at
    `.catch((error: unknown) => this.warn('upsertCapability', error));
  }

  saveUsage(capabilityId: string, usage: Usage): void {
    void this.sql`
      INSERT INTO conduit_usage (capability_id, invocations, spent, recent)
      VALUES (${capabilityId}, ${usage.invocations}, ${usage.spent},
              ${JSON.stringify(usage.recent)}::jsonb)
      ON CONFLICT (capability_id)
      DO UPDATE SET invocations = EXCLUDED.invocations, spent = EXCLUDED.spent,
                    recent = EXCLUDED.recent
    `.catch((error: unknown) => this.warn('saveUsage', error));
  }

  upsertAgent(agent: RegisteredAgent): void {
    void this.sql`
      INSERT INTO conduit_agents (agent_id, label, metadata, token_hash, registered_at)
      VALUES (${agent.agentId}, ${agent.label},
              ${JSON.stringify(agent.metadata)}::jsonb, ${agent.tokenHash},
              ${agent.registeredAt})
      ON CONFLICT (agent_id)
      DO UPDATE SET label = EXCLUDED.label, metadata = EXCLUDED.metadata,
                    token_hash = EXCLUDED.token_hash
    `.catch((error: unknown) => this.warn('upsertAgent', error));
  }

  close(): void {
    void this.sql.close();
  }

  private warn(op: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[conduit:postgres] ${op} failed: ${message}\n`);
  }
}
