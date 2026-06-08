import chalk from 'chalk';
import { Conduit } from '../kernel/index.ts';
import type { AuthorizationDecision, AuthorizationRequest } from '../kernel/index.ts';

// ─────────────────────────────────────────────────────────────────────────────
// conduit demo — a simulated AI agent governed by the authorization kernel.
//
// No API key, no network. It scripts one agent through a sequence of actions
// to show every path: allowed by rule, denied by rule, allowed by capability,
// blocked when a budget is exhausted, escalated to a human, and revoked.
// Run: bun run cli/index.ts
// ─────────────────────────────────────────────────────────────────────────────

const AGENT = 'agent.shopper';

function banner(text: string): void {
  process.stdout.write(`\n${chalk.bold.cyan(`── ${text} `.padEnd(74, '─'))}\n`);
}

function renderDecision(decision: AuthorizationDecision): string {
  if (decision.behavior === 'allow') {
    return `${chalk.bgGreen.black(' ALLOW ')} ${chalk.dim(`via ${decision.via} — ${decision.detail}`)}`;
  }
  if (decision.behavior === 'deny') {
    return `${chalk.bgRed.white(' DENY  ')} ${chalk.dim(decision.reason)}`;
  }
  return `${chalk.bgYellow.black(' ASK   ')} ${chalk.dim(`human approval needed — ${decision.reason}`)}`;
}

/** Simulate the agent attempting an action and route it through the kernel. */
async function attempt(conduit: Conduit, request: AuthorizationRequest): Promise<void> {
  const costNote = request.cost ? chalk.magenta(` ($${request.cost.amount})`) : '';
  process.stdout.write(`\n${chalk.white('agent wants:')} ${chalk.bold(request.action)}${costNote}\n`);

  const outcome = await conduit.run(request, async () => {
    return `executed ${request.action}`;
  });

  process.stdout.write(`  ${renderDecision(outcome.decision)}\n`);
  if (outcome.status === 'allowed') {
    process.stdout.write(`  ${chalk.green('→ action executed')}\n`);
  } else if (outcome.status === 'needs_approval') {
    process.stdout.write(`  ${chalk.yellow('→ paused; escalated to a human')}\n`);
  } else {
    process.stdout.write(`  ${chalk.red('→ blocked; agent cannot proceed')}\n`);
  }
}

async function main(): Promise<void> {
  process.stdout.write(chalk.bold('\n  conduit — the authorization kernel for AI agents\n'));

  // 1. Policy: coarse, always-on rules + a self-service onboarding policy.
  const conduit = new Conduit({
    defaultBehavior: 'ask',
    rules: [
      { action: 'web.*', behavior: 'allow', note: 'read-only research is free' },
      { action: 'system.*', behavior: 'deny', note: 'agents may never touch the host system' },
      { action: 'payment.*', behavior: 'ask', note: 'spending always needs explicit authority' },
    ],
    selfServe: {
      autoApproveActions: ['payment.*'],
      maxBudget: 200,
      maxInvocations: 3,
    },
  });

  banner('1. Policy rules loaded');
  process.stdout.write(
    `  ${chalk.green('allow')} web.*      ${chalk.dim('· research is free')}\n` +
      `  ${chalk.red('deny ')} system.*   ${chalk.dim('· host system is off-limits')}\n` +
      `  ${chalk.yellow('ask  ')} payment.*  ${chalk.dim('· spending needs a capability or a human')}\n`,
  );

  // 2. The agent onboards itself — no human. It registers, gets a token, and
  //    self-serves a spending capability that fits the self-serve policy.
  banner('2. The agent signs itself up — no human in the loop');
  const { token } = conduit.registerAgent({ agentId: AGENT, label: 'Shopping agent' });
  process.stdout.write(`  ${chalk.green('registered')} ${AGENT} ${chalk.dim(`· token ${token.slice(0, 12)}…`)}\n`);

  const request = conduit.requestCapability(AGENT, token, {
    action: 'payment.charge',
    constraints: { budget: { currency: 'USD', limit: 200 }, maxInvocations: 3 },
    expiresAt: Date.now() + 60 * 60 * 1000,
  });
  if (request.status !== 'granted') {
    throw new Error(`expected a self-service grant, got "${request.status}"`);
  }
  const capability = request.capability;
  process.stdout.write(
    `  ${chalk.bgGreen.black(' GRANTED ')} ${chalk.cyan(capability.id)} ${chalk.dim('— fits the self-serve policy, auto-approved')}\n` +
      `  ${chalk.dim('payment.charge · ≤ $200 total · ≤ 3 charges · expires in 1h')}\n`,
  );

  // 3. The agent runs.
  banner('3. The agent acts — every call passes through the kernel');
  await attempt(conduit, { agentId: AGENT, action: 'web.search', input: { q: 'office chairs' } });
  await attempt(conduit, { agentId: AGENT, action: 'system.exec', input: { cmd: 'rm -rf /' } });
  await attempt(conduit, {
    agentId: AGENT,
    action: 'payment.charge',
    input: { vendor: 'Acme' },
    cost: { currency: 'USD', amount: 80 },
  });
  await attempt(conduit, {
    agentId: AGENT,
    action: 'payment.charge',
    input: { vendor: 'Globex' },
    cost: { currency: 'USD', amount: 150 },
  });
  await attempt(conduit, { agentId: AGENT, action: 'email.send', input: { to: 'cfo@co.com' } });

  // 4. Revoke, then watch the same action lose its autonomy.
  banner('4. Revoking the capability mid-flight');
  conduit.revoke(capability.id);
  process.stdout.write(`  ${chalk.red('revoked')} ${chalk.dim(capability.id)}\n`);
  await attempt(conduit, {
    agentId: AGENT,
    action: 'payment.charge',
    input: { vendor: 'Acme' },
    cost: { currency: 'USD', amount: 20 },
  });

  // 5. The audit trail — tamper-evident proof of everything above.
  banner('5. Audit trail');
  for (const event of conduit.auditEntries()) {
    const tag = chalk.dim(`#${String(event.seq).padStart(2, '0')}`);
    process.stdout.write(
      `  ${tag} ${chalk.bold(event.type.padEnd(9))} ${event.agentId}  ${chalk.dim(event.hash.slice(0, 12))}\n`,
    );
  }
  const check = conduit.verifyAudit();
  process.stdout.write(
    check.valid
      ? `\n  ${chalk.bgGreen.black(' VERIFIED ')} chain intact — ${check.length} events, no tampering\n\n`
      : `\n  ${chalk.bgRed.white(' BROKEN ')} chain fails at event #${check.brokenAt}\n\n`,
  );
}

main().catch((error: unknown) => {
  process.stderr.write(chalk.red(`\nfatal: ${error instanceof Error ? error.message : String(error)}\n`));
  process.exit(1);
});
