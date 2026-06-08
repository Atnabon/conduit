import type { AuditEvent, AuditEventType, ChainVerification } from './audit.ts';

// ─────────────────────────────────────────────────────────────────────────────
// Compliance export — turn the audit log into evidence.
//
// A compliance report answers an auditor's question: "what was this agent
// allowed to do, what did it actually do, and can you prove the record wasn't
// edited?" It pairs the full event list with the hash-chain verification and a
// summary, so the export is self-certifying.
// ─────────────────────────────────────────────────────────────────────────────

export type ComplianceReport = {
  generatedAt: number;
  conduitVersion: string;
  integrity: ChainVerification;
  range: { from: number; to: number } | null;
  summary: {
    totalEvents: number;
    byType: Record<AuditEventType, number>;
    decisions: { allow: number; deny: number; ask: number };
    agents: string[];
    spendByCurrency: Record<string, number>;
  };
  events: readonly AuditEvent[];
};

const EVENT_TYPES: readonly AuditEventType[] = [
  'authorize',
  'invoke',
  'grant',
  'revoke',
  'approve',
  'reject',
];

/** Build a structured, self-certifying compliance report from an audit log. */
export function buildComplianceReport(
  events: readonly AuditEvent[],
  integrity: ChainVerification,
  conduitVersion = '0.1.0',
): ComplianceReport {
  const byType = Object.fromEntries(EVENT_TYPES.map((t) => [t, 0])) as Record<
    AuditEventType,
    number
  >;
  const decisions = { allow: 0, deny: 0, ask: 0 };
  const agents = new Set<string>();
  const spendByCurrency: Record<string, number> = {};

  for (const event of events) {
    byType[event.type] += 1;
    agents.add(event.agentId);

    if (event.type === 'authorize') {
      const behavior = readDecisionBehavior(event.payload);
      if (behavior) decisions[behavior] += 1;
    }
    if (event.type === 'invoke') {
      const cost = readCost(event.payload);
      if (cost) {
        spendByCurrency[cost.currency] = (spendByCurrency[cost.currency] ?? 0) + cost.amount;
      }
    }
  }

  return {
    generatedAt: Date.now(),
    conduitVersion,
    integrity,
    range:
      events.length > 0
        ? { from: events[0].timestamp, to: events[events.length - 1].timestamp }
        : null,
    summary: {
      totalEvents: events.length,
      byType,
      decisions,
      agents: [...agents].sort(),
      spendByCurrency,
    },
    events,
  };
}

/** Render a compliance report as a human-readable plain-text document. */
export function formatComplianceReport(report: ComplianceReport): string {
  const { summary, integrity } = report;
  const lines: string[] = [
    'CONDUIT COMPLIANCE REPORT',
    '='.repeat(60),
    `Generated:        ${new Date(report.generatedAt).toISOString()}`,
    `conduit version:  ${report.conduitVersion}`,
    `Events:           ${summary.totalEvents}`,
    report.range
      ? `Period:           ${new Date(report.range.from).toISOString()} → ${new Date(report.range.to).toISOString()}`
      : 'Period:           (no events)',
    '',
    'INTEGRITY',
    '-'.repeat(60),
    integrity.valid
      ? `PASS — hash chain intact across ${integrity.length} events. No tampering.`
      : `FAIL — chain broken at event #${integrity.brokenAt} (${integrity.reason}).`,
    '',
    'ACTIVITY',
    '-'.repeat(60),
    `Authorizations:   ${summary.byType.authorize}  (allow ${summary.decisions.allow} · deny ${summary.decisions.deny} · ask ${summary.decisions.ask})`,
    `Actions executed: ${summary.byType.invoke}`,
    `Capabilities:     ${summary.byType.grant} granted · ${summary.byType.revoke} revoked`,
    `Human approvals:  ${summary.byType.approve} approved · ${summary.byType.reject} rejected`,
    `Agents:           ${summary.agents.join(', ') || '(none)'}`,
    '',
    'SPEND',
    '-'.repeat(60),
  ];

  const currencies = Object.entries(summary.spendByCurrency);
  if (currencies.length === 0) {
    lines.push('No spend recorded.');
  } else {
    for (const [currency, amount] of currencies) {
      lines.push(`${currency}: ${amount}`);
    }
  }

  return `${lines.join('\n')}\n`;
}

function readDecisionBehavior(payload: unknown): 'allow' | 'deny' | 'ask' | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const decision = (payload as Record<string, unknown>).decision;
  if (typeof decision !== 'object' || decision === null) return null;
  const behavior = (decision as Record<string, unknown>).behavior;
  return behavior === 'allow' || behavior === 'deny' || behavior === 'ask' ? behavior : null;
}

function readCost(payload: unknown): { currency: string; amount: number } | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const cost = (payload as Record<string, unknown>).cost;
  if (typeof cost !== 'object' || cost === null) return null;
  const { currency, amount } = cost as Record<string, unknown>;
  return typeof currency === 'string' && typeof amount === 'number'
    ? { currency, amount }
    : null;
}
