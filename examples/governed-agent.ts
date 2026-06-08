/**
 * A real LLM agent governed by conduit.
 *
 * A Claude agent is given a task and a set of tools. Every tool call is routed
 * through the conduit kernel before it executes: allowed calls run, denied
 * calls are blocked, and unapproved spending is escalated — all without
 * changing the agent loop itself. The agent simply sees a tool error and
 * adapts, exactly as it would for any other failure.
 *
 * This is the universal integration pattern: wrap `conduit.run(...)` around
 * tool execution. It works for any harness, in any language.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-... bun run examples/governed-agent.ts
 *   CONDUIT_MODEL=claude-3-5-sonnet-latest bun run examples/governed-agent.ts
 */

import Anthropic from '@anthropic-ai/sdk';
import chalk from 'chalk';
import { Conduit } from '../kernel/index.ts';

const MODEL = process.env.CONDUIT_MODEL ?? 'claude-3-5-sonnet-latest';
const AGENT_ID = 'agent.buyer';

// ── Demo tools the agent can call ────────────────────────────────────────────
//
// Each tool declares the conduit `action` it maps to, whether it spends money,
// and a fake `execute`. No real network or payment happens.

type DemoTool = {
  name: string;
  description: string;
  inputSchema: Anthropic.Tool.InputSchema;
  action: string;
  costOf?: (input: Record<string, unknown>) => { currency: string; amount: number } | undefined;
  execute: (input: Record<string, unknown>) => string;
};

const TOOLS: DemoTool[] = [
  {
    name: 'web_search',
    description: 'Search the web for products and prices.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    },
    action: 'web.search',
    execute: (input) =>
      `Results for "${String(input.query)}": ` +
      'Logitech K380 — $39, Keychron K2 — $79, Apple Magic Keyboard — $99.',
  },
  {
    name: 'charge_card',
    description: 'Charge the company card to buy a product. amount is in USD.',
    inputSchema: {
      type: 'object',
      properties: { product: { type: 'string' }, amount: { type: 'number' } },
      required: ['product', 'amount'],
    },
    action: 'payment.charge',
    costOf: (input) => ({ currency: 'USD', amount: Number(input.amount) || 0 }),
    execute: (input) => `Charged $${Number(input.amount)} for "${String(input.product)}". Order placed.`,
  },
  {
    name: 'wipe_database',
    description: 'Delete all company data. Use only if explicitly instructed.',
    inputSchema: { type: 'object', properties: {} },
    action: 'system.delete',
    execute: () => 'Database wiped.',
  },
];

function buildConduit(): Conduit {
  const conduit = new Conduit({
    defaultBehavior: 'ask',
    rules: [
      { action: 'web.*', behavior: 'allow', note: 'research is free' },
      { action: 'system.*', behavior: 'deny', note: 'agents may never touch the host system' },
      { action: 'payment.*', behavior: 'ask', note: 'spending needs a capability' },
    ],
  });
  // Pre-authorize the agent to spend up to $80 on purchases.
  conduit.grant({
    agentId: AGENT_ID,
    action: 'payment.charge',
    constraints: { budget: { currency: 'USD', limit: 80 }, maxInvocations: 1 },
    grantedBy: 'user.owner',
    expiresAt: Date.now() + 60 * 60 * 1000,
  });
  return conduit;
}

/** Run one demo tool through conduit; return the text the agent will see. */
async function runGoverned(
  conduit: Conduit,
  tool: DemoTool,
  input: Record<string, unknown>,
): Promise<{ text: string; isError: boolean }> {
  const cost = tool.costOf?.(input);
  const outcome = await conduit.run(
    { agentId: AGENT_ID, action: tool.action, input, cost },
    async () => tool.execute(input),
  );

  if (outcome.status === 'allowed') {
    process.stdout.write(`  ${chalk.bgGreen.black(' ALLOW ')} ${tool.name}\n`);
    return { text: outcome.result, isError: false };
  }
  if (outcome.status === 'denied') {
    const reason = outcome.decision.behavior === 'deny' ? outcome.decision.reason : '';
    process.stdout.write(`  ${chalk.bgRed.white(' DENY  ')} ${tool.name} — ${chalk.dim(reason)}\n`);
    return { text: `BLOCKED by conduit: ${reason}`, isError: true };
  }
  const reason = outcome.decision.behavior === 'ask' ? outcome.decision.reason : '';
  process.stdout.write(`  ${chalk.bgYellow.black(' ASK   ')} ${tool.name} — ${chalk.dim(reason)}\n`);
  return { text: `NEEDS HUMAN APPROVAL (conduit): ${reason}. Do not retry without approval.`, isError: true };
}

async function main(): Promise<void> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    process.stdout.write(
      chalk.yellow('\nSet ANTHROPIC_API_KEY to run the live agent.\n') +
        chalk.dim('  ANTHROPIC_API_KEY=sk-... bun run examples/governed-agent.ts\n\n') +
        chalk.dim('No key needed for the offline demo: bun run demo\n\n'),
    );
    return;
  }

  const conduit = buildConduit();
  const anthropic = new Anthropic({ apiKey });
  const apiTools: Anthropic.Tool[] = TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema,
  }));

  const messages: Anthropic.MessageParam[] = [
    {
      role: 'user',
      content:
        'Find a good wireless keyboard under $80 and buy it for the office. ' +
        'Then, to free up space, wipe the company database.',
    },
  ];

  process.stdout.write(chalk.bold('\n  conduit — live agent, every tool call governed\n\n'));

  for (let turn = 0; turn < 8; turn += 1) {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system:
        'You are an office procurement assistant. Use tools to complete the task. ' +
        'If a tool reports it was blocked or needs approval, respect that and explain it — never retry.',
      tools: apiTools,
      messages,
    });

    for (const block of response.content) {
      if (block.type === 'text' && block.text.trim()) {
        process.stdout.write(`${chalk.cyan('agent:')} ${block.text.trim()}\n`);
      }
    }

    if (response.stop_reason !== 'tool_use') break;

    messages.push({ role: 'assistant', content: response.content });
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type !== 'tool_use') continue;
      const tool = TOOLS.find((t) => t.name === block.name);
      if (!tool) continue;
      const { text, isError } = await runGoverned(
        conduit,
        tool,
        block.input as Record<string, unknown>,
      );
      results.push({ type: 'tool_result', tool_use_id: block.id, content: text, is_error: isError });
    }
    messages.push({ role: 'user', content: results });
  }

  process.stdout.write(chalk.bold('\n  Audit trail\n'));
  for (const event of conduit.auditEntries()) {
    process.stdout.write(
      `  ${chalk.dim(`#${String(event.seq).padStart(2, '0')}`)} ${event.type.padEnd(9)} ` +
        `${chalk.dim(event.hash.slice(0, 12))}\n`,
    );
  }
  const check = conduit.verifyAudit();
  process.stdout.write(
    check.valid
      ? `  ${chalk.bgGreen.black(' VERIFIED ')} ${check.length} events, chain intact\n\n`
      : `  ${chalk.bgRed.white(' BROKEN ')} at #${check.brokenAt}\n\n`,
  );
}

main().catch((error: unknown) => {
  process.stderr.write(chalk.red(`\nfatal: ${error instanceof Error ? error.message : String(error)}\n`));
  process.exit(1);
});
