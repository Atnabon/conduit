import { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync } from 'node:fs';
import chalk from 'chalk';
import { Conduit, SqlitePersistence } from '../kernel/index.ts';

// ─────────────────────────────────────────────────────────────────────────────
// Tamper demo — proves the audit log is tamper-evident.
//
// 1. An agent runs; its actions are written to a real SQLite audit log.
// 2. We verify the hash chain — intact.
// 3. We bypass conduit entirely and edit a row in the database directly,
//    exactly as a malicious operator or a breached host would.
// 4. We reload the kernel and verify again — the chain is broken, and conduit
//    points at the precise event that was altered.
//
// Run: bun run cli/tamper.ts
// ─────────────────────────────────────────────────────────────────────────────

const dbPath = join(tmpdir(), `conduit-tamper-${randomUUID()}.db`);

function cleanup(): void {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      unlinkSync(dbPath + suffix);
    } catch {
      // file may not exist — fine.
    }
  }
}

async function main(): Promise<void> {
  process.stdout.write(chalk.bold('\n  conduit — audit tamper demo\n'));

  // ── 1. An agent acts; the audit log lands in SQLite ────────────────────────
  const store = new SqlitePersistence(dbPath);
  const conduit = new Conduit({
    persistence: store,
    rules: [
      { action: 'web.*', behavior: 'allow' },
      { action: 'payment.*', behavior: 'ask' },
    ],
  });
  conduit.grant({
    agentId: 'agent.a',
    action: 'payment.charge',
    constraints: { budget: { currency: 'USD', limit: 500 } },
    grantedBy: 'user.owner',
  });
  await conduit.run({ agentId: 'agent.a', action: 'web.search', input: {} }, async () => 'ok');
  await conduit.run(
    { agentId: 'agent.a', action: 'payment.charge', input: {}, cost: { currency: 'USD', amount: 480 } },
    async () => 'charged $480',
  );
  store.close();

  process.stdout.write(
    `\n  ${chalk.dim('An agent ran 2 actions — including a $480 charge.')}\n` +
      `  ${chalk.dim('Audit log written to')} ${chalk.dim(dbPath)}\n`,
  );

  // ── 2. Verify the untouched chain ──────────────────────────────────────────
  const before = new Conduit({ persistence: new SqlitePersistence(dbPath) });
  const beforeCheck = before.verifyAudit();
  process.stdout.write(
    `\n  ${chalk.bold('Verify (before tampering)')}\n  ` +
      (beforeCheck.valid
        ? `${chalk.bgGreen.black(' VERIFIED ')} chain intact — ${beforeCheck.length} events\n`
        : `${chalk.bgRed.white(' BROKEN ')}\n`),
  );

  // ── 3. Tamper directly in the database, behind conduit's back ──────────────
  const raw = new Database(dbPath);
  const target = raw
    .query("SELECT seq, payload FROM events WHERE type = 'invoke' ORDER BY seq LIMIT 1")
    .get() as { seq: number; payload: string };
  const forged = JSON.parse(target.payload) as Record<string, unknown>;
  forged.cost = { currency: 'USD', amount: 5 }; // hide the real $480 charge as $5
  raw.query('UPDATE events SET payload = $p WHERE seq = $s').run({ $p: JSON.stringify(forged), $s: target.seq });
  raw.close();

  process.stdout.write(
    `\n  ${chalk.bold('Attacker edits the database directly')}\n` +
      `  ${chalk.red(`event #${target.seq}`)} ${chalk.dim('— rewrote the charge from $480 to $5')}\n`,
  );

  // ── 4. Reload and verify again ─────────────────────────────────────────────
  const after = new Conduit({ persistence: new SqlitePersistence(dbPath) });
  const afterCheck = after.verifyAudit();
  process.stdout.write(
    `\n  ${chalk.bold('Verify (after tampering)')}\n  ` +
      (afterCheck.valid
        ? `${chalk.bgGreen.black(' VERIFIED ')} (unexpected — the demo failed)\n`
        : `${chalk.bgRed.white(' TAMPERING DETECTED ')} chain breaks at event #${afterCheck.brokenAt} — ${afterCheck.reason}\n`),
  );

  process.stdout.write(
    `\n  ${chalk.dim('The edited row no longer matches its hash, and every')}\n` +
      `  ${chalk.dim('later hash chains off it — so the forgery is undeniable.')}\n\n`,
  );
}

main()
  .catch((error: unknown) => {
    process.stderr.write(chalk.red(`\nfatal: ${error instanceof Error ? error.message : String(error)}\n`));
    process.exitCode = 1;
  })
  .finally(cleanup);
