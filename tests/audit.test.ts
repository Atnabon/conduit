import { describe, expect, test } from 'bun:test';
import { AuditLog, type AuditEvent } from '../kernel/audit.ts';

describe('AuditLog', () => {
  test('assigns sequential seq numbers', () => {
    const log = new AuditLog();
    log.append('authorize', 'a', {});
    log.append('invoke', 'a', {});
    expect(log.entries().map((e) => e.seq)).toEqual([0, 1]);
  });

  test('each event chains to the previous hash', () => {
    const log = new AuditLog();
    const first = log.append('authorize', 'a', {});
    const second = log.append('invoke', 'a', {});
    expect(second.prevHash).toBe(first.hash);
  });

  test('a clean chain verifies', () => {
    const log = new AuditLog();
    log.append('grant', 'a', { capabilityId: 'cap_1' });
    log.append('authorize', 'a', { action: 'payment.charge' });
    const result = log.verify();
    expect(result.valid).toBe(true);
  });

  test('onAppend hook fires for each event', () => {
    const seen: AuditEvent[] = [];
    const log = new AuditLog({ onAppend: (e) => seen.push(e) });
    log.append('authorize', 'a', {});
    expect(seen).toHaveLength(1);
  });

  test('detects a tampered payload', () => {
    const log = new AuditLog();
    log.append('authorize', 'a', { amount: 10 });
    log.append('invoke', 'a', { amount: 10 });

    // Reconstruct a log whose event #0 payload has been altered.
    const tampered = structuredClone(log.entries()) as AuditEvent[];
    tampered[0] = { ...tampered[0], payload: { amount: 9_999_999 } };
    const reloaded = new AuditLog({ initial: tampered });

    const result = reloaded.verify();
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.brokenAt).toBe(0);
  });

  test('detects a deleted event (broken chain link)', () => {
    const log = new AuditLog();
    log.append('authorize', 'a', {});
    log.append('invoke', 'a', {});
    log.append('revoke', 'a', {});

    const withGap = [log.entries()[0], log.entries()[2]] as AuditEvent[];
    const reloaded = new AuditLog({ initial: withGap });
    expect(reloaded.verify().valid).toBe(false);
  });

  test('restored chain continues unbroken across a restart', () => {
    const first = new AuditLog();
    first.append('grant', 'a', {});
    const resumed = new AuditLog({ initial: first.entries() });
    resumed.append('authorize', 'a', {});
    expect(resumed.verify().valid).toBe(true);
  });
});
