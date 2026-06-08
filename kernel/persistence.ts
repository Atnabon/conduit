import { Database } from 'bun:sqlite';
import type { AuditEvent, AuditEventType } from './audit.ts';
import type { Capability, Usage } from './capability.ts';
import type { RegisteredAgent } from './registry.ts';

// ─────────────────────────────────────────────────────────────────────────────
// Persistence — the audit log and capability grants must survive a restart, or
// conduit is not a trust product. `ConduitPersistence` is the storage seam;
// `SqlitePersistence` is the local/default implementation (bun:sqlite). A
// hosted Postgres implementation satisfies the same interface in production.
// ─────────────────────────────────────────────────────────────────────────────

export interface ConduitPersistence {
  loadEvents(): AuditEvent[];
  appendEvent(event: AuditEvent): void;
  loadCapabilities(): Capability[];
  loadUsage(): Map<string, Usage>;
  upsertCapability(capability: Capability): void;
  saveUsage(capabilityId: string, usage: Usage): void;
  loadAgents(): RegisteredAgent[];
  upsertAgent(agent: RegisteredAgent): void;
  close(): void;
}

/** SQLite-backed persistence. `path` may be `:memory:` for ephemeral use. */
export class SqlitePersistence implements ConduitPersistence {
  private readonly db: Database;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.run('PRAGMA journal_mode = WAL');
    this.db.run(`
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY,
        timestamp INTEGER NOT NULL,
        type TEXT NOT NULL,
        agentId TEXT NOT NULL,
        payload TEXT NOT NULL,
        prevHash TEXT NOT NULL,
        hash TEXT NOT NULL
      )`);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS capabilities (
        id TEXT PRIMARY KEY,
        agentId TEXT NOT NULL,
        action TEXT NOT NULL,
        constraints TEXT NOT NULL,
        grantedBy TEXT NOT NULL,
        grantedAt INTEGER NOT NULL,
        expiresAt INTEGER,
        revokedAt INTEGER
      )`);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS usage (
        capabilityId TEXT PRIMARY KEY,
        invocations INTEGER NOT NULL,
        spent REAL NOT NULL,
        recent TEXT NOT NULL DEFAULT '[]'
      )`);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS agents (
        agentId TEXT PRIMARY KEY,
        label TEXT,
        metadata TEXT NOT NULL,
        tokenHash TEXT NOT NULL,
        registeredAt INTEGER NOT NULL
      )`);
    // Migration for databases created before velocity limiting existed.
    const hasRecent = (
      this.db.query("PRAGMA table_info(usage)").all() as { name: string }[]
    ).some((c) => c.name === 'recent');
    if (!hasRecent) {
      this.db.run("ALTER TABLE usage ADD COLUMN recent TEXT NOT NULL DEFAULT '[]'");
    }
  }

  loadEvents(): AuditEvent[] {
    const rows = this.db
      .query('SELECT * FROM events ORDER BY seq ASC')
      .all() as EventRow[];
    return rows.map((r) => ({
      seq: r.seq,
      timestamp: r.timestamp,
      type: r.type as AuditEventType,
      agentId: r.agentId,
      payload: JSON.parse(r.payload) as Record<string, unknown>,
      prevHash: r.prevHash,
      hash: r.hash,
    }));
  }

  appendEvent(event: AuditEvent): void {
    this.db
      .query(
        `INSERT INTO events (seq, timestamp, type, agentId, payload, prevHash, hash)
         VALUES ($seq, $timestamp, $type, $agentId, $payload, $prevHash, $hash)`,
      )
      .run({
        $seq: event.seq,
        $timestamp: event.timestamp,
        $type: event.type,
        $agentId: event.agentId,
        $payload: JSON.stringify(event.payload),
        $prevHash: event.prevHash,
        $hash: event.hash,
      });
  }

  loadCapabilities(): Capability[] {
    const rows = this.db.query('SELECT * FROM capabilities').all() as CapabilityRow[];
    return rows.map((r) => ({
      id: r.id,
      agentId: r.agentId,
      action: r.action,
      constraints: JSON.parse(r.constraints) as Capability['constraints'],
      grantedBy: r.grantedBy,
      grantedAt: r.grantedAt,
      expiresAt: r.expiresAt,
      revokedAt: r.revokedAt,
    }));
  }

  loadUsage(): Map<string, Usage> {
    const rows = this.db.query('SELECT * FROM usage').all() as UsageRow[];
    return new Map(
      rows.map((r) => [
        r.capabilityId,
        { invocations: r.invocations, spent: r.spent, recent: JSON.parse(r.recent) as number[] },
      ]),
    );
  }

  upsertCapability(capability: Capability): void {
    this.db
      .query(
        `INSERT INTO capabilities (id, agentId, action, constraints, grantedBy, grantedAt, expiresAt, revokedAt)
         VALUES ($id, $agentId, $action, $constraints, $grantedBy, $grantedAt, $expiresAt, $revokedAt)
         ON CONFLICT(id) DO UPDATE SET revokedAt = $revokedAt`,
      )
      .run({
        $id: capability.id,
        $agentId: capability.agentId,
        $action: capability.action,
        $constraints: JSON.stringify(capability.constraints),
        $grantedBy: capability.grantedBy,
        $grantedAt: capability.grantedAt,
        $expiresAt: capability.expiresAt,
        $revokedAt: capability.revokedAt,
      });
  }

  saveUsage(capabilityId: string, usage: Usage): void {
    this.db
      .query(
        `INSERT INTO usage (capabilityId, invocations, spent, recent)
         VALUES ($id, $invocations, $spent, $recent)
         ON CONFLICT(capabilityId)
         DO UPDATE SET invocations = $invocations, spent = $spent, recent = $recent`,
      )
      .run({
        $id: capabilityId,
        $invocations: usage.invocations,
        $spent: usage.spent,
        $recent: JSON.stringify(usage.recent),
      });
  }

  loadAgents(): RegisteredAgent[] {
    const rows = this.db.query('SELECT * FROM agents').all() as AgentRow[];
    return rows.map((r) => ({
      agentId: r.agentId,
      label: r.label,
      metadata: JSON.parse(r.metadata) as Record<string, unknown>,
      tokenHash: r.tokenHash,
      registeredAt: r.registeredAt,
    }));
  }

  upsertAgent(agent: RegisteredAgent): void {
    this.db
      .query(
        `INSERT INTO agents (agentId, label, metadata, tokenHash, registeredAt)
         VALUES ($agentId, $label, $metadata, $tokenHash, $registeredAt)
         ON CONFLICT(agentId)
         DO UPDATE SET label = $label, metadata = $metadata, tokenHash = $tokenHash`,
      )
      .run({
        $agentId: agent.agentId,
        $label: agent.label,
        $metadata: JSON.stringify(agent.metadata),
        $tokenHash: agent.tokenHash,
        $registeredAt: agent.registeredAt,
      });
  }

  close(): void {
    this.db.close();
  }
}

type EventRow = {
  seq: number;
  timestamp: number;
  type: string;
  agentId: string;
  payload: string;
  prevHash: string;
  hash: string;
};

type CapabilityRow = {
  id: string;
  agentId: string;
  action: string;
  constraints: string;
  grantedBy: string;
  grantedAt: number;
  expiresAt: number | null;
  revokedAt: number | null;
};

type UsageRow = { capabilityId: string; invocations: number; spent: number; recent: string };

type AgentRow = {
  agentId: string;
  label: string | null;
  metadata: string;
  tokenHash: string;
  registeredAt: number;
};
