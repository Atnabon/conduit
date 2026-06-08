// ─────────────────────────────────────────────────────────────────────────────
// Discovery — conduit's machine-readable self-description.
//
// "Software for agents" means an agent should be able to *land on* a service
// and figure out what it can do and how to onboard — with no human reading
// docs. conduit makes that the normal path through two unauthenticated routes:
//
//   GET /.well-known/agent-manifest.json  → the agent manifest (what + how)
//   GET /openapi.json                     → a full OpenAPI 3.1 description
//
// Both are public: an agent must be able to read them *before* it holds any
// credential. The manifest is the human-free runbook; the OpenAPI spec is the
// exhaustive contract that agent tooling parses automatically.
// ─────────────────────────────────────────────────────────────────────────────

export const CONDUIT_VERSION = '0.1.0';
/** API surface version. Paths are stable within a major version. */
export const CONDUIT_API_VERSION = 'v0';

const GITHUB = 'https://github.com/conduit-dev/conduit';

export type DiscoveryOptions = {
  /** True when the control plane runs in commercial (multi-tenant) mode. */
  commercial?: boolean;
};

// ── OpenAPI 3.1 spec ─────────────────────────────────────────────────────────

const errorSchema = {
  type: 'object',
  properties: { error: { type: 'string', description: 'Human- and agent-readable failure reason.' } },
  required: ['error'],
} as const;

const decisionSchema = {
  type: 'object',
  description: 'The verdict for a single agent action.',
  properties: {
    behavior: { type: 'string', enum: ['allow', 'deny', 'ask'] },
    reason: { type: 'string' },
    source: {
      type: 'string',
      enum: ['rule', 'capability', 'default'],
      description: 'Which layer produced the verdict.',
    },
  },
  required: ['behavior'],
} as const;

const constraintProps = {
  maxInvocations: { type: 'integer', minimum: 1, description: 'Total times the capability may be used.' },
  budgetCurrency: { type: 'string', example: 'USD' },
  budgetLimit: { type: 'number', minimum: 0, description: 'Total spend ceiling in the given currency.' },
  rateMaxInvocations: { type: 'integer', minimum: 1, description: 'Velocity cap: uses allowed per window.' },
  rateWindowSeconds: { type: 'integer', minimum: 1, description: 'Velocity window length, in seconds.' },
  expiresInSeconds: { type: 'integer', minimum: 1, description: 'Capability lifetime from now, in seconds.' },
} as const;

/** Build the full OpenAPI 3.1 document describing every control-plane route. */
export function buildOpenApiSpec(): Record<string, unknown> {
  return {
    openapi: '3.1.0',
    info: {
      title: 'conduit control plane',
      version: CONDUIT_VERSION,
      summary: 'The authorization kernel for AI agents.',
      description:
        'conduit answers one question for every agent action — "may this agent take this action, right now?" — and records the verdict in a tamper-evident audit log. This API is agent-first: an agent can register itself, request its own scoped capabilities, and act, with no human in the loop.',
      license: { name: 'MIT', url: `${GITHUB}/blob/main/LICENSE` },
      contact: { name: 'conduit', url: GITHUB },
    },
    servers: [{ url: '/', description: 'This control plane.' }],
    tags: [
      { name: 'discovery', description: 'Machine-readable self-description.' },
      { name: 'onboarding', description: 'Human-free agent registration and capability requests.' },
      { name: 'authorization', description: 'The core allow / deny / ask decision.' },
      { name: 'policy', description: 'Coarse always-on permission rules.' },
      { name: 'capabilities', description: 'Scoped, budgeted, expiring autonomy.' },
      { name: 'approvals', description: 'Human-in-the-loop review of escalated requests.' },
      { name: 'audit', description: 'The tamper-evident record and compliance exports.' },
      { name: 'billing', description: 'Accounts and plan quotas (commercial mode).' },
    ],
    components: {
      securitySchemes: {
        accountKey: {
          type: 'http',
          scheme: 'bearer',
          description: 'An account API key (`ck_...`). Required for every /api/* route in commercial mode.',
        },
      },
      schemas: {
        Error: errorSchema,
        Decision: decisionSchema,
      },
    },
    paths: {
      '/.well-known/agent-manifest.json': {
        get: {
          tags: ['discovery'],
          operationId: 'getAgentManifest',
          summary: 'The agent manifest — what conduit is and how to onboard.',
          description: 'Unauthenticated. The human-free runbook an agent reads first.',
          responses: { '200': { description: 'The agent manifest.' } },
        },
      },
      '/openapi.json': {
        get: {
          tags: ['discovery'],
          operationId: 'getOpenApi',
          summary: 'This OpenAPI 3.1 document.',
          responses: { '200': { description: 'The OpenAPI specification.' } },
        },
      },
      '/health': {
        get: {
          tags: ['discovery'],
          operationId: 'getHealth',
          summary: 'Liveness probe.',
          responses: { '200': { description: 'The service is up.' } },
        },
      },
      '/api/plans': {
        get: {
          tags: ['billing'],
          operationId: 'listPlans',
          summary: 'The public plan catalog.',
          description: 'Unauthenticated — an agent can compare plans before signing up.',
          responses: { '200': { description: 'The list of plans.' } },
        },
      },
      '/api/agents': {
        get: {
          tags: ['onboarding'],
          operationId: 'listAgents',
          summary: 'List registered agents.',
          responses: { '200': { description: 'Registered agents (no token hashes).' } },
        },
        post: {
          tags: ['onboarding'],
          operationId: 'registerAgent',
          summary: 'Step 1 — an agent registers itself.',
          description: 'Returns a one-time token, shown exactly once; only its hash is stored.',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    agentId: { type: 'string', example: 'agent.shopper' },
                    label: { type: 'string', description: 'Optional human-readable label.' },
                    metadata: { type: 'object', additionalProperties: true },
                  },
                  required: ['agentId'],
                },
              },
            },
          },
          responses: {
            '201': { description: 'The agent is registered; `token` is returned once.' },
            '400': { description: 'Invalid body.', content: { 'application/json': { schema: errorSchema } } },
          },
        },
      },
      '/api/capability-requests': {
        post: {
          tags: ['onboarding'],
          operationId: 'requestCapability',
          summary: 'Step 2 — an agent requests its own capability.',
          description:
            'Authenticated by the agent token from step 1. Within the self-serve policy → `granted`. Over policy → `pending` (parked for a human). Denied by a rule or bad token → `rejected`.',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    agentId: { type: 'string', example: 'agent.shopper' },
                    token: { type: 'string', description: 'The one-time token from POST /api/agents.' },
                    action: { type: 'string', example: 'payment.charge' },
                    ...constraintProps,
                  },
                  required: ['agentId', 'token', 'action'],
                },
              },
            },
          },
          responses: {
            '201': { description: 'status `granted` — a capability was issued.' },
            '202': { description: 'status `pending` — parked for human approval; see `approvalId`.' },
            '403': { description: 'status `rejected` — denied by a rule, or a bad token.' },
          },
        },
      },
      '/api/authorize': {
        post: {
          tags: ['authorization'],
          operationId: 'authorize',
          summary: 'Step 3 — ask whether an agent may take an action.',
          description: 'The core kernel decision. A metered route in commercial mode.',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    agentId: { type: 'string' },
                    action: { type: 'string', example: 'payment.charge' },
                    input: { type: 'object', additionalProperties: true },
                    cost: {
                      type: 'object',
                      properties: { currency: { type: 'string' }, amount: { type: 'number' } },
                      required: ['currency', 'amount'],
                    },
                  },
                  required: ['agentId', 'action'],
                },
              },
            },
          },
          responses: {
            '200': {
              description: 'The decision.',
              content: { 'application/json': { schema: decisionSchema } },
            },
            '402': {
              description: 'Monthly quota exceeded (commercial mode).',
              content: { 'application/json': { schema: errorSchema } },
            },
          },
        },
      },
      '/api/rules': {
        get: {
          tags: ['policy'],
          operationId: 'listRules',
          summary: 'List permission rules.',
          responses: { '200': { description: 'The ordered rule list.' } },
        },
        post: {
          tags: ['policy'],
          operationId: 'addRule',
          summary: 'Add a permission rule.',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    action: { type: 'string', example: 'payment.*' },
                    behavior: { type: 'string', enum: ['allow', 'deny', 'ask'] },
                    priority: { type: 'integer' },
                    note: { type: 'string' },
                  },
                  required: ['action', 'behavior'],
                },
              },
            },
          },
          responses: { '201': { description: 'The rule was added.' } },
        },
      },
      '/api/capabilities': {
        get: {
          tags: ['capabilities'],
          operationId: 'listCapabilities',
          summary: 'List capabilities for an agent.',
          parameters: [
            { name: 'agentId', in: 'query', required: true, schema: { type: 'string' } },
          ],
          responses: { '200': { description: "The agent's capabilities." } },
        },
        post: {
          tags: ['capabilities'],
          operationId: 'grantCapability',
          summary: 'Grant a capability directly (operator action).',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    agentId: { type: 'string' },
                    action: { type: 'string' },
                    grantedBy: { type: 'string' },
                    ...constraintProps,
                  },
                  required: ['agentId', 'action', 'grantedBy'],
                },
              },
            },
          },
          responses: { '201': { description: 'The capability was granted.' } },
        },
      },
      '/api/capabilities/{id}/revoke': {
        post: {
          tags: ['capabilities'],
          operationId: 'revokeCapability',
          summary: 'Revoke a capability.',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { '200': { description: 'Revocation result.' } },
        },
      },
      '/api/approvals': {
        get: {
          tags: ['approvals'],
          operationId: 'listApprovals',
          summary: 'List pending approvals.',
          responses: { '200': { description: 'Approvals awaiting a human.' } },
        },
      },
      '/api/approvals/{id}/approve': {
        post: {
          tags: ['approvals'],
          operationId: 'approveRequest',
          summary: 'Approve a pending request.',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: {
            content: {
              'application/json': {
                schema: { type: 'object', properties: { approvedBy: { type: 'string' } } },
              },
            },
          },
          responses: {
            '200': { description: 'Approved — a one-shot grant was issued.' },
            '404': { description: 'Not found or already resolved.' },
          },
        },
      },
      '/api/approvals/{id}/reject': {
        post: {
          tags: ['approvals'],
          operationId: 'rejectRequest',
          summary: 'Reject a pending request.',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: {
            content: {
              'application/json': {
                schema: { type: 'object', properties: { rejectedBy: { type: 'string' } } },
              },
            },
          },
          responses: {
            '200': { description: 'Rejected — the action stays blocked.' },
            '404': { description: 'Not found or already resolved.' },
          },
        },
      },
      '/api/audit': {
        get: {
          tags: ['audit'],
          operationId: 'getAudit',
          summary: 'Read the audit log.',
          parameters: [
            { name: 'limit', in: 'query', schema: { type: 'integer', default: 100 } },
          ],
          responses: { '200': { description: 'The most recent audit events.' } },
        },
      },
      '/api/audit/verify': {
        get: {
          tags: ['audit'],
          operationId: 'verifyAudit',
          summary: 'Verify the audit hash chain.',
          responses: { '200': { description: '`{ valid, length }` — or where the chain broke.' } },
        },
      },
      '/api/compliance-report': {
        get: {
          tags: ['audit'],
          operationId: 'getComplianceReport',
          summary: 'A self-certifying compliance report (JSON).',
          responses: { '200': { description: 'The compliance report.' } },
        },
      },
      '/api/compliance-report.txt': {
        get: {
          tags: ['audit'],
          operationId: 'getComplianceReportText',
          summary: 'The compliance report as human-readable text.',
          responses: { '200': { description: 'The report, as text/plain.' } },
        },
      },
      '/api/account': {
        get: {
          tags: ['billing'],
          operationId: 'getAccount',
          summary: 'This account, with current usage (commercial mode).',
          security: [{ accountKey: [] }],
          responses: { '200': { description: 'The account usage summary.' } },
        },
      },
      '/api/account/plan': {
        post: {
          tags: ['billing'],
          operationId: 'setPlan',
          summary: 'Change this account’s plan (commercial mode).',
          security: [{ accountKey: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { plan: { type: 'string', enum: ['free', 'team', 'enterprise'] } },
                  required: ['plan'],
                },
              },
            },
          },
          responses: { '200': { description: 'The updated account.' } },
        },
      },
      '/api/accounts': {
        get: {
          tags: ['billing'],
          operationId: 'listAccounts',
          summary: 'List accounts (commercial mode).',
          security: [{ accountKey: [] }],
          responses: { '200': { description: 'Account metadata (never key hashes).' } },
        },
        post: {
          tags: ['billing'],
          operationId: 'createAccount',
          summary: 'Create an account (commercial mode, admin key).',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    name: { type: 'string' },
                    plan: { type: 'string', enum: ['free', 'team', 'enterprise'], default: 'free' },
                  },
                  required: ['name'],
                },
              },
            },
          },
          responses: {
            '201': { description: 'The account; `apiKey` is returned exactly once.' },
            '401': { description: 'Admin key required.' },
          },
        },
      },
    },
  };
}

// ── Agent manifest ───────────────────────────────────────────────────────────

/**
 * Build the agent manifest — the human-free runbook served at
 * `/.well-known/agent-manifest.json`. An agent reads this first to learn what
 * conduit is, how to authenticate, and the exact steps to onboard itself.
 */
export function buildAgentManifest(options: DiscoveryOptions = {}): Record<string, unknown> {
  const commercial = options.commercial ?? false;
  const spec = buildOpenApiSpec();
  const paths = spec.paths as Record<string, Record<string, { summary?: string }>>;

  // Derive a compact endpoint index from the OpenAPI paths — no drift.
  const endpoints = Object.entries(paths).flatMap(([path, methods]) =>
    Object.entries(methods).map(([method, op]) => ({
      method: method.toUpperCase(),
      path,
      summary: op.summary ?? '',
    })),
  );

  return {
    conduit: CONDUIT_VERSION,
    apiVersion: CONDUIT_API_VERSION,
    kind: 'agent-authorization-service',
    name: 'conduit',
    summary:
      'The authorization kernel for AI agents — permissions, scoped capabilities, and a tamper-evident audit log.',
    description:
      'conduit answers one question for every agent action — "may this agent take this action, right now?" — and records the verdict in a SHA-256 hash-chained audit log. An agent registers itself, requests its own scoped capabilities, and acts, with no human in the loop.',
    primitives: {
      permissions: 'Coarse, always-on policy: allow / deny / ask, matched by glob action patterns.',
      capabilities: 'Scoped, budgeted, rate-limited, expiring autonomy granted to a single agent.',
      audit: 'A SHA-256 hash-chained record of every decision and action; tampering is detectable.',
    },
    authentication: commercial
      ? {
          mode: 'commercial',
          scheme: 'bearer',
          header: 'Authorization: Bearer ck_...',
          description:
            'Every /api/* route requires an account API key (ck_...). Obtain one from your operator, or via POST /api/accounts with the admin key. Agents additionally authenticate to /api/capability-requests with the one-time token from POST /api/agents.',
        }
      : {
          mode: 'open',
          scheme: 'agent-token',
          description:
            'This control plane is open: agents register and request capabilities directly. The one-time token from POST /api/agents still gates POST /api/capability-requests.',
        },
    onboarding: {
      summary:
        'A three-step, human-free path from "never seen conduit" to "acting under a scoped capability".',
      steps: [
        {
          step: 1,
          name: 'register',
          method: 'POST',
          path: '/api/agents',
          body: { agentId: 'agent.you', label: 'optional human-readable label' },
          returns:
            'A one-time `token`. Store it immediately — it is shown exactly once and only its hash is kept.',
        },
        {
          step: 2,
          name: 'request a capability',
          method: 'POST',
          path: '/api/capability-requests',
          body: {
            agentId: 'agent.you',
            token: '<token from step 1>',
            action: 'payment.charge',
            budgetCurrency: 'USD',
            budgetLimit: 40,
            maxInvocations: 3,
            expiresInSeconds: 3600,
          },
          returns:
            'status `granted` (within policy, a capability is issued), `pending` (over policy, parked for a human — see `approvalId`), or `rejected` (denied by a rule, or a bad token).',
        },
        {
          step: 3,
          name: 'authorize an action',
          method: 'POST',
          path: '/api/authorize',
          body: {
            agentId: 'agent.you',
            action: 'payment.charge',
            cost: { currency: 'USD', amount: 12 },
          },
          returns:
            'A decision — `allow` (proceed), `deny` (blocked by policy), or `ask` (a human must approve first).',
        },
      ],
    },
    mcp: {
      description:
        'conduit is also an MCP server — an MCP-capable harness can govern itself with no HTTP and no UI.',
      transports: {
        stdio: 'bun run mcp/index.ts',
        http: 'bun run mcp/http.ts',
      },
      tools: [
        'register_agent',
        'request_capability',
        'authorize',
        'grant_capability',
        'revoke_capability',
        'list_capabilities',
        'get_audit_trail',
        'verify_audit',
      ],
    },
    endpoints,
    documentation: {
      openapi: '/openapi.json',
      plans: '/api/plans',
      health: '/health',
      source: GITHUB,
      quickstart: `${GITHUB}/blob/main/QUICKSTART.md`,
    },
  };
}
