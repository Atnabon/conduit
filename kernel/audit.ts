import { createHash } from 'node:crypto';

// ─────────────────────────────────────────────────────────────────────────────
// Audit log — a tamper-evident record of every kernel decision and action.
//
// Each event embeds the hash of the previous event, forming a chain. Altering
// any past event changes its hash, which breaks every hash after it — so
// tampering is detectable by recomputing the chain. This is what lets conduit
// produce trustworthy evidence of what an agent was permitted to do, and did.
// (Technique borrowed from goderash's hash-chained event ledger.)
// ─────────────────────────────────────────────────────────────────────────────

export type AuditEventType =
  | 'authorize'
  | 'invoke'
  | 'grant'
  | 'revoke'
  | 'approve'
  | 'reject'
  | 'register'
  | 'request';

export type AuditEvent = {
  seq: number;
  timestamp: number;
  type: AuditEventType;
  agentId: string;
  payload: Readonly<Record<string, unknown>>;
  prevHash: string;
  hash: string;
};

export type ChainVerification =
  | { valid: true; length: number }
  | { valid: false; brokenAt: number; reason: string };

const GENESIS_HASH = '0'.repeat(64);

/** Deterministic JSON: object keys sorted recursively so hashing is stable. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
}

function hashEvent(event: Omit<AuditEvent, 'hash'>): string {
  const material = canonical({
    seq: event.seq,
    timestamp: event.timestamp,
    type: event.type,
    agentId: event.agentId,
    payload: event.payload,
    prevHash: event.prevHash,
  });
  return createHash('sha256').update(material).digest('hex');
}

export type AuditLogOptions = {
  /** Events to restore on construction (e.g. loaded from persistence). */
  initial?: readonly AuditEvent[];
  /** Called after each successful append — used to persist durably. */
  onAppend?: (event: AuditEvent) => void;
};

/**
 * An append-only, hash-chained event log. Holds events in memory; an optional
 * `onAppend` hook mirrors each event to durable storage, and `initial` restores
 * a prior chain so the hash chain continues unbroken across restarts.
 */
export class AuditLog {
  private readonly events: AuditEvent[];
  private readonly onAppend?: (event: AuditEvent) => void;

  constructor(options: AuditLogOptions = {}) {
    this.events = options.initial ? [...options.initial] : [];
    this.onAppend = options.onAppend;
  }

  append(
    type: AuditEventType,
    agentId: string,
    payload: Readonly<Record<string, unknown>>,
  ): AuditEvent {
    const prev = this.events[this.events.length - 1];
    const unhashed: Omit<AuditEvent, 'hash'> = {
      seq: this.events.length,
      timestamp: Date.now(),
      type,
      agentId,
      payload,
      prevHash: prev ? prev.hash : GENESIS_HASH,
    };
    const event: AuditEvent = { ...unhashed, hash: hashEvent(unhashed) };
    this.events.push(event);
    this.onAppend?.(event);
    return event;
  }

  entries(): readonly AuditEvent[] {
    return this.events;
  }

  last(): AuditEvent | null {
    return this.events[this.events.length - 1] ?? null;
  }

  /** Recompute the chain and report the first event (if any) that fails. */
  verify(): ChainVerification {
    let prevHash = GENESIS_HASH;
    for (const event of this.events) {
      if (event.prevHash !== prevHash) {
        return { valid: false, brokenAt: event.seq, reason: 'prevHash mismatch' };
      }
      const recomputed = hashEvent(event);
      if (recomputed !== event.hash) {
        return { valid: false, brokenAt: event.seq, reason: 'hash mismatch (event altered)' };
      }
      prevHash = event.hash;
    }
    return { valid: true, length: this.events.length };
  }
}
