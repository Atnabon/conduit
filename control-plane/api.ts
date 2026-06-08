import { z } from 'zod';
import {
  buildComplianceReport,
  type Conduit,
  formatComplianceReport,
} from '../kernel/index.ts';
import { type Account, type AccountStore, PLANS, type PlanName } from './billing.ts';
import { DASHBOARD_HTML } from './dashboard.ts';
import { buildAgentManifest, buildOpenApiSpec } from './discovery.ts';

// ─────────────────────────────────────────────────────────────────────────────
// Control-plane HTTP API — the hosted layer over the kernel.
//
// A team (or a dashboard) manages policy, capabilities, and audit through this
// REST API. `createControlPlane` returns a plain `Request -> Response` handler,
// so it can be served by `Bun.serve` or unit-tested by calling it directly.
// ─────────────────────────────────────────────────────────────────────────────

export type ControlPlaneOptions = {
  /**
   * Legacy single-key mode: when set (and `accounts` is not), every `/api/*`
   * route requires `Authorization: Bearer <apiKey>`.
   */
  apiKey?: string;
  /**
   * Commercial mode: when set, `/api/*` routes require an account API key
   * (`Authorization: Bearer ck_...`), and metered routes are quota-enforced.
   */
  accounts?: AccountStore;
  /** Required to create accounts via `POST /api/accounts` when `accounts` is set. */
  adminKey?: string;
};

/** Routes whose calls count against an account's monthly plan quota. */
const METERED_ROUTES = new Set(['/api/authorize', '/api/capability-requests']);

const createAccountBody = z.object({
  name: z.string().min(1),
  plan: z.enum(['free', 'team', 'enterprise']).default('free'),
});

const setPlanBody = z.object({ plan: z.enum(['free', 'team', 'enterprise']) });

export type ControlPlaneHandler = (req: Request) => Promise<Response>;

const grantBody = z.object({
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

const ruleBody = z.object({
  action: z.string().min(1),
  behavior: z.enum(['allow', 'deny', 'ask']),
  priority: z.number().int().optional(),
  note: z.string().optional(),
});

const authorizeBody = z.object({
  agentId: z.string().min(1),
  action: z.string().min(1),
  input: z.record(z.string(), z.unknown()).default({}),
  cost: z.object({ currency: z.string(), amount: z.number() }).optional(),
});

const registerBody = z.object({
  agentId: z.string().min(1),
  label: z.string().min(1).optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
});

const capabilityRequestBody = z.object({
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

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function html(body: string): Response {
  return new Response(body, { headers: { 'content-type': 'text/html; charset=utf-8' } });
}

async function parseBody(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return {};
  }
}

function bearer(req: Request): string | null {
  const header = req.headers.get('authorization');
  return header?.startsWith('Bearer ') ? header.slice(7) : null;
}

/** Build a control-plane request handler bound to a kernel instance. */
export function createControlPlane(
  conduit: Conduit,
  options: ControlPlaneOptions = {},
): ControlPlaneHandler {
  const accounts = options.accounts;

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const { pathname } = url;
    const method = req.method.toUpperCase();

    if (pathname === '/' && method === 'GET') return html(DASHBOARD_HTML);
    if (pathname === '/health') return json({ ok: true, service: 'conduit-control-plane' });

    // ── Discovery — unauthenticated, so an agent can read them before it holds
    //    any credential. The "software for agents" self-description layer.
    if (pathname === '/.well-known/agent-manifest.json' && method === 'GET') {
      return json(buildAgentManifest({ commercial: Boolean(accounts) }));
    }
    if (pathname === '/openapi.json' && method === 'GET') {
      return json(buildOpenApiSpec());
    }

    if (!pathname.startsWith('/api/')) return json({ error: 'not found' }, 404);

    // The plan catalog is public — agents and humans can read it unauthenticated.
    if (pathname === '/api/plans' && method === 'GET') {
      return json(Object.values(PLANS));
    }

    let account: Account | undefined;

    if (accounts) {
      // Commercial mode. Account creation is gated by the admin key; every
      // other route requires a valid account API key.
      if (pathname === '/api/accounts' && method === 'POST') {
        if (!options.adminKey || bearer(req) !== options.adminKey) {
          return json({ error: 'admin key required' }, 401);
        }
        try {
          const body = createAccountBody.parse(await parseBody(req));
          const { account: created, apiKey } = accounts.createAccount(body.name, body.plan);
          // The API key is returned exactly once — only its hash is stored.
          return json({ account: created, apiKey }, 201);
        } catch (error: unknown) {
          return json({ error: error instanceof Error ? error.message : String(error) }, 400);
        }
      }

      const key = bearer(req);
      const resolved = key ? accounts.authenticate(key) : null;
      if (!resolved) return json({ error: 'unauthorized — provide an account API key' }, 401);
      account = resolved;

      // Quota enforcement: a metered call by an over-quota account is refused
      // with HTTP 402 until the plan is upgraded.
      if (METERED_ROUTES.has(pathname)) {
        const summary = accounts.summary(account.id);
        if (summary?.overQuota) {
          return json(
            { error: 'monthly quota exceeded', plan: summary.plan.name, quota: summary.quota },
            402,
          );
        }
      }
    } else if (options.apiKey) {
      if (bearer(req) !== options.apiKey) return json({ error: 'unauthorized' }, 401);
    }

    try {
      const res = await route(conduit, pathname, method, url, req, accounts, account);
      // Count a successful metered call against the account's plan.
      if (account && accounts && METERED_ROUTES.has(pathname) && res.ok) {
        accounts.recordAuthorization(account.id);
      }
      return res;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return json({ error: message }, 400);
    }
  };
}

async function route(
  conduit: Conduit,
  pathname: string,
  method: string,
  url: URL,
  req: Request,
  accounts?: AccountStore,
  account?: Account,
): Promise<Response> {
  // ── Account + billing ──────────────────────────────────────────────────────
  if (pathname === '/api/account' && method === 'GET') {
    if (!accounts || !account) return json({ error: 'commercial mode not enabled' }, 404);
    return json(accounts.summary(account.id));
  }
  if (pathname === '/api/account/plan' && method === 'POST') {
    if (!accounts || !account) return json({ error: 'commercial mode not enabled' }, 404);
    const body = setPlanBody.parse(await parseBody(req));
    return json(accounts.setPlan(account.id, body.plan as PlanName));
  }
  if (pathname === '/api/accounts' && method === 'GET') {
    if (!accounts) return json({ error: 'commercial mode not enabled' }, 404);
    // Account metadata only — never the key hashes.
    return json(accounts.list().map((a) => ({ id: a.id, name: a.name, plan: a.plan, createdAt: a.createdAt })));
  }

  // ── Policy rules ───────────────────────────────────────────────────────────
  if (pathname === '/api/rules' && method === 'GET') {
    return json(conduit.rules());
  }
  if (pathname === '/api/rules' && method === 'POST') {
    const body = ruleBody.parse(await parseBody(req));
    conduit.addRule(body);
    return json({ added: body }, 201);
  }

  // ── Capabilities ───────────────────────────────────────────────────────────
  if (pathname === '/api/capabilities' && method === 'GET') {
    const agentId = url.searchParams.get('agentId');
    if (!agentId) return json({ error: 'agentId query param required' }, 400);
    return json(conduit.capabilitiesFor(agentId));
  }
  if (pathname === '/api/capabilities' && method === 'POST') {
    const b = grantBody.parse(await parseBody(req));
    const budget =
      b.budgetCurrency && b.budgetLimit !== undefined
        ? { currency: b.budgetCurrency, limit: b.budgetLimit }
        : undefined;
    const rateLimit =
      b.rateMaxInvocations !== undefined && b.rateWindowSeconds !== undefined
        ? { maxInvocations: b.rateMaxInvocations, windowMs: b.rateWindowSeconds * 1000 }
        : undefined;
    const capability = conduit.grant({
      agentId: b.agentId,
      action: b.action,
      grantedBy: b.grantedBy,
      constraints: { maxInvocations: b.maxInvocations, budget, rateLimit },
      expiresAt: b.expiresInSeconds ? Date.now() + b.expiresInSeconds * 1000 : null,
    });
    return json(capability, 201);
  }
  const revokeMatch = pathname.match(/^\/api\/capabilities\/([^/]+)\/revoke$/);
  if (revokeMatch && method === 'POST') {
    return json({ revoked: conduit.revoke(revokeMatch[1]) });
  }

  // ── Agents (self-service onboarding) ───────────────────────────────────────
  if (pathname === '/api/agents' && method === 'GET') {
    return json(conduit.agents());
  }
  if (pathname === '/api/agents' && method === 'POST') {
    const b = registerBody.parse(await parseBody(req));
    const { agent, token } = conduit.registerAgent({
      agentId: b.agentId,
      label: b.label,
      metadata: b.metadata,
    });
    // The token is returned exactly once — only its hash is stored.
    return json({ agentId: agent.agentId, token, registeredAt: agent.registeredAt }, 201);
  }
  if (pathname === '/api/capability-requests' && method === 'POST') {
    const b = capabilityRequestBody.parse(await parseBody(req));
    const budget =
      b.budgetCurrency && b.budgetLimit !== undefined
        ? { currency: b.budgetCurrency, limit: b.budgetLimit }
        : undefined;
    const rateLimit =
      b.rateMaxInvocations !== undefined && b.rateWindowSeconds !== undefined
        ? { maxInvocations: b.rateMaxInvocations, windowMs: b.rateWindowSeconds * 1000 }
        : undefined;
    const result = conduit.requestCapability(b.agentId, b.token, {
      action: b.action,
      constraints: { maxInvocations: b.maxInvocations, budget, rateLimit },
      expiresAt: b.expiresInSeconds ? Date.now() + b.expiresInSeconds * 1000 : null,
    });
    const status = result.status === 'rejected' ? 403 : result.status === 'granted' ? 201 : 202;
    return json(result, status);
  }

  // ── Authorization ──────────────────────────────────────────────────────────
  if (pathname === '/api/authorize' && method === 'POST') {
    const b = authorizeBody.parse(await parseBody(req));
    return json(conduit.authorize({ agentId: b.agentId, action: b.action, input: b.input, cost: b.cost }));
  }

  // ── Approvals (human-in-the-loop) ──────────────────────────────────────────
  if (pathname === '/api/approvals' && method === 'GET') {
    return json(conduit.pendingApprovals());
  }
  const approveMatch = pathname.match(/^\/api\/approvals\/([^/]+)\/approve$/);
  if (approveMatch && method === 'POST') {
    const body = (await parseBody(req)) as { approvedBy?: string };
    const resolved = conduit.approveRequest(approveMatch[1], body.approvedBy ?? 'control-plane');
    return resolved ? json(resolved) : json({ error: 'approval not found or already resolved' }, 404);
  }
  const rejectMatch = pathname.match(/^\/api\/approvals\/([^/]+)\/reject$/);
  if (rejectMatch && method === 'POST') {
    const body = (await parseBody(req)) as { rejectedBy?: string };
    const resolved = conduit.rejectRequest(rejectMatch[1], body.rejectedBy ?? 'control-plane');
    return resolved ? json(resolved) : json({ error: 'approval not found or already resolved' }, 404);
  }

  // ── Audit + compliance ─────────────────────────────────────────────────────
  if (pathname === '/api/audit' && method === 'GET') {
    const limit = Number(url.searchParams.get('limit') ?? '100');
    return json(conduit.auditEntries().slice(-limit));
  }
  if (pathname === '/api/audit/verify' && method === 'GET') {
    return json(conduit.verifyAudit());
  }
  if (pathname === '/api/compliance-report' && method === 'GET') {
    return json(buildComplianceReport(conduit.auditEntries(), conduit.verifyAudit()));
  }
  if (pathname === '/api/compliance-report.txt' && method === 'GET') {
    const report = buildComplianceReport(conduit.auditEntries(), conduit.verifyAudit());
    return new Response(formatComplianceReport(report), {
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  }

  return json({ error: `no route for ${method} ${pathname}` }, 404);
}
