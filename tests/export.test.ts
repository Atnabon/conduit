import { describe, expect, test } from 'bun:test';
import { Conduit } from '../kernel/conduit.ts';
import { buildComplianceReport, formatComplianceReport } from '../kernel/export.ts';

async function activeConduit(): Promise<Conduit> {
  const conduit = new Conduit({
    rules: [
      { action: 'web.*', behavior: 'allow' },
      { action: 'system.*', behavior: 'deny' },
      { action: 'payment.*', behavior: 'ask' },
    ],
  });
  conduit.grant({
    agentId: 'agent.a',
    action: 'payment.*',
    constraints: { budget: { currency: 'USD', limit: 100 } },
    grantedBy: 'user',
  });
  await conduit.run({ agentId: 'agent.a', action: 'web.search', input: {} }, async () => 'ok');
  await conduit.run(
    { agentId: 'agent.a', action: 'payment.charge', input: {}, cost: { currency: 'USD', amount: 30 } },
    async () => 'charged',
  );
  await conduit.run({ agentId: 'agent.a', action: 'system.exec', input: {} }, async () => 'x');
  return conduit;
}

describe('compliance export', () => {
  test('summarises decisions, spend, and integrity', async () => {
    const conduit = await activeConduit();
    const report = buildComplianceReport(conduit.auditEntries(), conduit.verifyAudit());

    expect(report.integrity.valid).toBe(true);
    expect(report.summary.decisions.allow).toBeGreaterThan(0);
    expect(report.summary.decisions.deny).toBe(1);
    expect(report.summary.spendByCurrency.USD).toBe(30);
    expect(report.summary.agents).toContain('agent.a');
  });

  test('reflects a broken chain in the report', () => {
    const report = buildComplianceReport([], {
      valid: false,
      brokenAt: 3,
      reason: 'hash mismatch',
    });
    expect(report.integrity.valid).toBe(false);
  });

  test('formats a human-readable document', async () => {
    const conduit = await activeConduit();
    const text = formatComplianceReport(
      buildComplianceReport(conduit.auditEntries(), conduit.verifyAudit()),
    );
    expect(text).toContain('CONDUIT COMPLIANCE REPORT');
    expect(text).toContain('PASS');
    expect(text).toContain('USD: 30');
  });
});
