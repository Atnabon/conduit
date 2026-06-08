/**
 * conduit MCP server — transport-agnostic.
 *
 * Exposes the authorization kernel as Model Context Protocol tools, so any
 * agent or harness can govern itself programmatically — discover conduit,
 * authorize actions, hold capabilities, and read its own audit trail without a
 * human in the loop. This is conduit *as software for agents*: a machine-
 * readable interface, not a dashboard.
 *
 * Structure mirrors source-code-full/mcp-server/src/server.ts — a low-level
 * `Server` with `ListTools` / `CallTool` request handlers.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { Conduit } from '../kernel/index.ts';

// ── Tool argument schemas ────────────────────────────────────────────────────

const authorizeArgs = z.object({
  agentId: z.string().min(1),
  action: z.string().min(1),
  input: z.record(z.string(), z.unknown()).default({}),
  cost: z.object({ currency: z.string(), amount: z.number() }).optional(),
});

const grantArgs = z.object({
  agentId: z.string().min(1),
  action: z.string().min(1),
  grantedBy: z.string().min(1),
  maxInvocations: z.number().int().positive().optional(),
  budgetCurrency: z.string().optional(),
  budgetLimit: z.number().nonnegative().optional(),
  rateMaxInvocations: z.number().int().positive().optional(),
  rateWindowSeconds: z.number().int().positive().optional(),
  expiresInSeconds: z.number().int().positive().optional(),
});

const revokeArgs = z.object({ capabilityId: z.string().min(1) });
const listArgs = z.object({ agentId: z.string().min(1) });
const auditArgs = z.object({ limit: z.number().int().positive().max(1000).default(100) });

const registerArgs = z.object({
  agentId: z.string().min(1),
  label: z.string().min(1).optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
});

const requestCapabilityArgs = z.object({
  agentId: z.string().min(1),
  token: z.string().min(1),
  action: z.string().min(1),
  maxInvocations: z.number().int().positive().optional(),
  budgetCurrency: z.string().optional(),
  budgetLimit: z.number().nonnegative().optional(),
  rateMaxInvocations: z.number().int().positive().optional(),
  rateWindowSeconds: z.number().int().positive().optional(),
  expiresInSeconds: z.number().int().positive().optional(),
});

// ── Tool catalog (advertised to agents via ListTools) ────────────────────────

const TOOL_DEFINITIONS = [
  {
    name: 'register_agent',
    description:
      'Sign up a new agent with conduit and receive a secret token. The token is returned once — present it on every later request. This is the human-free onboarding step.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        agentId: { type: 'string', description: 'Stable identifier the agent will present.' },
        label: { type: 'string', description: 'Human-friendly label for dashboards.' },
        metadata: { type: 'object', description: 'Free-form metadata — harness, owner, version.' },
      },
      required: ['agentId'],
    },
  },
  {
    name: 'request_capability',
    description:
      'Request a scoped capability for yourself. Authenticate with your token. If the request fits the self-serve policy it is granted instantly; otherwise it is parked for human approval. No human needed for the safe path.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        agentId: { type: 'string' },
        token: { type: 'string', description: 'The token issued at register_agent.' },
        action: { type: 'string', description: 'Glob pattern, e.g. "payment.*".' },
        maxInvocations: { type: 'number' },
        budgetCurrency: { type: 'string' },
        budgetLimit: { type: 'number' },
        rateMaxInvocations: { type: 'number' },
        rateWindowSeconds: { type: 'number' },
        expiresInSeconds: { type: 'number' },
      },
      required: ['agentId', 'token', 'action'],
    },
  },
  {
    name: 'authorize',
    description:
      'Ask the kernel to rule on an action before an agent performs it. Returns allow / deny / ask and records the decision in the audit log.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        agentId: { type: 'string', description: 'The agent requesting the action.' },
        action: { type: 'string', description: 'Action name, e.g. "payment.charge".' },
        input: { type: 'object', description: 'Action parameters (matched against capability constraints).' },
        cost: {
          type: 'object',
          description: 'Spend amount, for budget-constrained actions.',
          properties: { currency: { type: 'string' }, amount: { type: 'number' } },
        },
      },
      required: ['agentId', 'action'],
    },
  },
  {
    name: 'grant_capability',
    description:
      'Issue a scoped, budgeted, expiring capability to an agent — the unit of delegated autonomy.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        agentId: { type: 'string' },
        action: { type: 'string', description: 'Glob pattern, e.g. "payment.*".' },
        grantedBy: { type: 'string', description: 'Human user id or policy id authorizing the grant.' },
        maxInvocations: { type: 'number', description: 'Optional cap on number of uses.' },
        budgetCurrency: { type: 'string' },
        budgetLimit: { type: 'number', description: 'Optional total spend ceiling.' },
        rateMaxInvocations: { type: 'number', description: 'Optional velocity limit: max uses per window.' },
        rateWindowSeconds: { type: 'number', description: 'Velocity window in seconds (required with rateMaxInvocations).' },
        expiresInSeconds: { type: 'number', description: 'Optional lifetime in seconds.' },
      },
      required: ['agentId', 'action', 'grantedBy'],
    },
  },
  {
    name: 'revoke_capability',
    description: 'Revoke a capability immediately. Any in-flight autonomy it granted is withdrawn.',
    inputSchema: {
      type: 'object' as const,
      properties: { capabilityId: { type: 'string' } },
      required: ['capabilityId'],
    },
  },
  {
    name: 'list_capabilities',
    description: 'List every capability held by an agent, including revoked ones.',
    inputSchema: {
      type: 'object' as const,
      properties: { agentId: { type: 'string' } },
      required: ['agentId'],
    },
  },
  {
    name: 'get_audit_trail',
    description: 'Return the most recent audit events — a tamper-evident record of decisions and actions.',
    inputSchema: {
      type: 'object' as const,
      properties: { limit: { type: 'number', description: 'Max events to return (default 100).' } },
    },
  },
  {
    name: 'verify_audit',
    description: 'Verify the audit log hash chain is intact and has not been tampered with.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
];

// ── Server factory ───────────────────────────────────────────────────────────

function ok(payload: unknown): { content: { type: 'text'; text: string }[] } {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}

/** Build a conduit MCP server bound to a kernel instance. */
export function createConduitServer(conduit: Conduit): Server {
  const server = new Server(
    { name: 'conduit', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DEFINITIONS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    switch (name) {
      case 'register_agent': {
        const a = registerArgs.parse(args ?? {});
        const { agent, token } = conduit.registerAgent({
          agentId: a.agentId,
          label: a.label,
          metadata: a.metadata,
        });
        return ok({ agentId: agent.agentId, token, registeredAt: agent.registeredAt });
      }
      case 'request_capability': {
        const a = requestCapabilityArgs.parse(args ?? {});
        const budget =
          a.budgetCurrency && a.budgetLimit !== undefined
            ? { currency: a.budgetCurrency, limit: a.budgetLimit }
            : undefined;
        const rateLimit =
          a.rateMaxInvocations !== undefined && a.rateWindowSeconds !== undefined
            ? { maxInvocations: a.rateMaxInvocations, windowMs: a.rateWindowSeconds * 1000 }
            : undefined;
        return ok(
          conduit.requestCapability(a.agentId, a.token, {
            action: a.action,
            constraints: { maxInvocations: a.maxInvocations, budget, rateLimit },
            expiresAt: a.expiresInSeconds ? Date.now() + a.expiresInSeconds * 1000 : null,
          }),
        );
      }
      case 'authorize': {
        const a = authorizeArgs.parse(args ?? {});
        return ok(conduit.authorize({ agentId: a.agentId, action: a.action, input: a.input, cost: a.cost }));
      }
      case 'grant_capability': {
        const a = grantArgs.parse(args ?? {});
        const budget =
          a.budgetCurrency && a.budgetLimit !== undefined
            ? { currency: a.budgetCurrency, limit: a.budgetLimit }
            : undefined;
        const rateLimit =
          a.rateMaxInvocations !== undefined && a.rateWindowSeconds !== undefined
            ? { maxInvocations: a.rateMaxInvocations, windowMs: a.rateWindowSeconds * 1000 }
            : undefined;
        const capability = conduit.grant({
          agentId: a.agentId,
          action: a.action,
          grantedBy: a.grantedBy,
          constraints: { maxInvocations: a.maxInvocations, budget, rateLimit },
          expiresAt: a.expiresInSeconds ? Date.now() + a.expiresInSeconds * 1000 : null,
        });
        return ok(capability);
      }
      case 'revoke_capability': {
        const a = revokeArgs.parse(args ?? {});
        return ok({ revoked: conduit.revoke(a.capabilityId) });
      }
      case 'list_capabilities': {
        const a = listArgs.parse(args ?? {});
        return ok(conduit.capabilitiesFor(a.agentId));
      }
      case 'get_audit_trail': {
        const a = auditArgs.parse(args ?? {});
        return ok(conduit.auditEntries().slice(-a.limit));
      }
      case 'verify_audit': {
        return ok(conduit.verifyAudit());
      }
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  });

  return server;
}
