import type { Conduit } from './conduit.ts';
import type { Tool } from './types.ts';

// ─────────────────────────────────────────────────────────────────────────────
// Tool governance — the one-line adoption path.
//
// `governTool` wraps any existing agent tool so every call is authorized by
// conduit first. A harness adopts conduit without changing how it calls tools:
// the wrapped tool has the same shape, but a denied or unapproved call returns
// a structured error instead of executing.
// ─────────────────────────────────────────────────────────────────────────────

export type GovernOptions<TInput> = {
  /** Action name sent to the kernel. Defaults to the tool's own `name`. */
  action?: string;
  /** Derive a spend amount from the tool input, for budget-constrained tools. */
  cost?: (input: TInput) => { currency: string; amount: number } | undefined;
};

/**
 * Return a copy of `tool` whose `call` is gated by `conduit` on behalf of
 * `agentId`. Allowed calls run normally; denied/ask calls short-circuit with a
 * `ToolResult` error so the agent loop can react without crashing.
 */
export function governTool<TInput>(
  conduit: Conduit,
  agentId: string,
  tool: Tool<TInput>,
  options: GovernOptions<TInput> = {},
): Tool<TInput> {
  const action = options.action ?? tool.name;

  return {
    ...tool,
    call: async (input, ctx) => {
      const outcome = await conduit.run(
        {
          agentId,
          action,
          input: input as Readonly<Record<string, unknown>>,
          cost: options.cost?.(input),
        },
        () => tool.call(input, ctx),
      );

      if (outcome.status === 'allowed') return outcome.result;

      const decision = outcome.decision;
      const reason = decision.behavior === 'allow' ? '' : decision.reason;
      return outcome.status === 'denied'
        ? { ok: false, error: `conduit denied "${action}": ${reason}` }
        : { ok: false, error: `conduit requires human approval for "${action}": ${reason}` };
    },
  };
}
