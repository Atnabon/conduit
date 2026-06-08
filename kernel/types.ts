import type { z } from 'zod';

// ─────────────────────────────────────────────────────────────────────────────
// Tool primitives — the unit of action an agent performs.
// ─────────────────────────────────────────────────────────────────────────────

export type ToolResult =
  | { ok: true; data: unknown; display?: string }
  | { ok: false; error: string };

export type ToolContext = {
  outcomeId: string;
  memory: OutcomeMemory;
  abortSignal: AbortSignal;
  log: (level: 'info' | 'warn' | 'error', msg: string, meta?: unknown) => void;
};

export type Tool<TInput = unknown> = {
  name: string;
  description: string;
  inputSchema: z.ZodType<TInput>;
  isReadOnly: boolean;
  isConcurrencySafe: boolean;
  call: (input: TInput, ctx: ToolContext) => Promise<ToolResult>;
};

// ─────────────────────────────────────────────────────────────────────────────
// Authorization — the conduit governance kernel.
//
// Every action an agent attempts is an `AuthorizationRequest`. The kernel
// resolves it to an `AuthorizationDecision` by consulting permission rules and
// capability grants, and records the result in a tamper-evident audit log.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A single action an agent wants to take, submitted to the kernel for a ruling.
 *
 * `cost` is optional and only meaningful for actions that spend a budget
 * (payments, paid API calls). It is matched against capability budgets.
 */
export type AuthorizationRequest = {
  agentId: string;
  action: string;
  input: Readonly<Record<string, unknown>>;
  cost?: { currency: string; amount: number };
};

export type PermissionBehavior = 'allow' | 'deny' | 'ask';

/**
 * The kernel's ruling on an `AuthorizationRequest`.
 *
 * - `allow`  — the agent may proceed without human involvement.
 * - `deny`   — the action is forbidden; the agent must not proceed.
 * - `ask`    — a human must approve before the agent proceeds.
 */
export type AuthorizationDecision =
  | {
      behavior: 'allow';
      via: 'rule' | 'capability';
      detail: string;
      /** Set when `via` is `capability` — the grant that covered the request. */
      capabilityId?: string;
    }
  | { behavior: 'deny'; reason: string }
  | { behavior: 'ask'; reason: string };

/**
 * A permission rule. `action` is a glob pattern (`*` matches any run of
 * characters) tested against the request's `action`. Rules are the coarse,
 * always-on policy layer; capabilities are the fine-grained, scoped layer.
 */
export type PermissionRule = {
  action: string;
  behavior: PermissionBehavior;
  /** Higher priority rules are evaluated first. Defaults to 0. */
  priority?: number;
  /** Free-text note surfaced in the decision and audit log. */
  note?: string;
};

// ─────────────────────────────────────────────────────────────────────────────
// Conversation + outcome state (harness side).
// ─────────────────────────────────────────────────────────────────────────────

export type Message =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: AssistantContent[] }
  | { role: 'tool'; toolUseId: string; content: string; isError?: boolean };

export type AssistantContent =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown };

export type OutcomeStatus = 'pending' | 'running' | 'done' | 'failed';

export type OutcomeRecord = {
  id: string;
  goal: string;
  status: OutcomeStatus;
  createdAt: number;
  updatedAt: number;
  artifacts: Record<string, unknown>;
  messages: Message[];
};

export interface OutcomeMemory {
  get(): OutcomeRecord;
  setStatus(status: OutcomeStatus): void;
  appendMessage(msg: Message): void;
  setArtifact(key: string, value: unknown): void;
  getArtifact<T = unknown>(key: string): T | undefined;
}
