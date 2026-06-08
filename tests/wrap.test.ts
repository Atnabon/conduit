import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { Conduit } from '../kernel/conduit.ts';
import { governTool } from '../kernel/wrap.ts';
import type { OutcomeMemory, Tool, ToolContext } from '../kernel/types.ts';

// A throwaway ToolContext — the demo tools below never touch memory.
const memory = {
  get: () => ({
    id: 'o1',
    goal: '',
    status: 'running' as const,
    createdAt: 0,
    updatedAt: 0,
    artifacts: {},
    messages: [],
  }),
  setStatus: () => {},
  appendMessage: () => {},
  setArtifact: () => {},
  getArtifact: () => undefined,
} satisfies OutcomeMemory;

const ctx: ToolContext = {
  outcomeId: 'o1',
  memory,
  abortSignal: new AbortController().signal,
  log: () => {},
};

const echoTool: Tool<{ value: string }> = {
  name: 'echo',
  description: 'echoes its input',
  inputSchema: z.object({ value: z.string() }),
  isReadOnly: true,
  isConcurrencySafe: true,
  call: async (input) => ({ ok: true, data: input.value }),
};

describe('governTool', () => {
  test('an allowed tool call passes through and executes', async () => {
    const conduit = new Conduit({ rules: [{ action: 'echo', behavior: 'allow' }] });
    const governed = governTool(conduit, 'agent.a', echoTool);
    const result = await governed.call({ value: 'hi' }, ctx);
    expect(result).toEqual({ ok: true, data: 'hi' });
  });

  test('a denied tool call returns a structured error and does not execute', async () => {
    const conduit = new Conduit({ rules: [{ action: 'echo', behavior: 'deny' }] });
    let ran = false;
    const tool: Tool<{ value: string }> = {
      ...echoTool,
      call: async (input) => {
        ran = true;
        return { ok: true, data: input.value };
      },
    };
    const governed = governTool(conduit, 'agent.a', tool);
    const result = await governed.call({ value: 'hi' }, ctx);
    expect(result.ok).toBe(false);
    expect(ran).toBe(false);
  });

  test('an ask verdict surfaces as an approval-required error', async () => {
    const conduit = new Conduit({ defaultBehavior: 'ask' });
    const governed = governTool(conduit, 'agent.a', echoTool);
    const result = await governed.call({ value: 'hi' }, ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('approval');
  });

  test('the cost mapper feeds capability budgets', async () => {
    const conduit = new Conduit({ rules: [{ action: 'echo', behavior: 'ask' }] });
    conduit.grant({
      agentId: 'agent.a',
      action: 'echo',
      constraints: { budget: { currency: 'USD', limit: 10 } },
      grantedBy: 'user',
    });
    const governed = governTool(conduit, 'agent.a', echoTool, {
      cost: () => ({ currency: 'USD', amount: 5 }),
    });
    const first = await governed.call({ value: 'a' }, ctx);
    expect(first.ok).toBe(true);
    const second = await governed.call({ value: 'b' }, ctx);
    expect(second.ok).toBe(true);
    const third = await governed.call({ value: 'c' }, ctx); // budget now exhausted
    expect(third.ok).toBe(false);
  });
});
