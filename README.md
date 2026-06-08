# conduit

**The authorization kernel for AI agents.**

Agents are starting to *act* — they buy things, move money, change records, manage
systems. But there is no trust layer for that. Who decided this agent could spend
$500? Within what limits? How is it scoped, logged, revoked? Today the answer is
hardcoded `if` statements, or nothing at all.

conduit is that missing layer. One small kernel an agent harness wraps every tool
call through. It answers a single question — *"may this agent take this action,
right now?"* — and records the verdict in a tamper-evident log.

Think **Okta for agents**: the permission, capability, and audit layer the agent
economy runs on.

---

## Why this exists

> "Agents need a completely different foundation… the biggest opportunity might be
> building the software those agents depend on."
> — Y Combinator, *Software for Agents* (RFS)

Everyone is building agents. Almost no one is building the **software agents
depend on to act safely**. conduit is that software — and it is itself agent-first:
machine-readable, MCP-native, no dashboard required.

---

## Quick start

```bash
bun install
bun run demo           # offline: a simulated agent governed by the kernel
bun run tamper         # proves the audit log is tamper-evident
bun test               # the kernel test suite
bun run agent          # live: a real Claude agent (needs ANTHROPIC_API_KEY)
bun run mcp            # conduit as an MCP server (stdio)
bun run mcp:http       # conduit as an MCP server (HTTP / SSE)
bun run control-plane  # the hosted API + dashboard → http://localhost:4000
bun run site           # the landing page → http://localhost:4200
```

New to conduit? The [60-second quickstart](./QUICKSTART.md) is the fastest path
from `bun add conduit` to a governed tool call.

---

## The three primitives

### 1. Permissions — coarse, always-on policy

```ts
const conduit = new Conduit({
  rules: [
    { action: 'web.*',     behavior: 'allow', note: 'research is free' },
    { action: 'system.*',  behavior: 'deny',  note: 'never touch the host' },
    { action: 'payment.*', behavior: 'ask',   note: 'spending needs authority' },
  ],
});
```

`deny` always wins. No rule? Falls through to capabilities.

### 2. Capabilities — scoped, budgeted, expiring autonomy

A capability is how an agent is trusted to act *without a human in the loop* —
safely, because every limit is explicit.

```ts
conduit.grant({
  agentId: 'agent.shopper',
  action: 'payment.charge',
  constraints: {
    budget: { currency: 'USD', limit: 200 },
    maxInvocations: 3,
    rateLimit: { maxInvocations: 1, windowMs: 60_000 }, // ≤ 1 charge / minute
  },
  grantedBy: 'user.owner',
  expiresAt: Date.now() + 60 * 60 * 1000,   // 1 hour
});
```

A capability can upgrade an `ask` action to `allow` — until its budget, count,
velocity, or clock runs out, or it is revoked. A total budget can't stop a
runaway agent from spending it all in one second; `rateLimit` caps how fast.

### 3. Audit — a tamper-evident record of everything

Every decision and every executed action is written to a SHA-256 hash-chained
log. Alter any past event and every later hash breaks — tampering is detectable.

```ts
conduit.verifyAudit();   // → { valid: true, length: 10 }
```

---

## Governing an agent

The universal integration — wrap `conduit.run(...)` around tool execution. Works
for any harness, in any language:

```ts
const outcome = await conduit.run(
  { agentId, action: 'payment.charge', input, cost: { currency: 'USD', amount: 80 } },
  async () => actuallyChargeTheCard(input),
);

if (outcome.status === 'allowed')        { /* it ran */ }
else if (outcome.status === 'denied')    { /* blocked */ }
else if (outcome.status === 'needs_approval') { /* outcome.approvalId */ }
```

For conduit-native tools, `governTool` makes adoption one line:

```ts
const safeTool = governTool(conduit, agentId, anyTool);
```

---

## Human-in-the-loop approvals

When the kernel returns `ask`, the action is parked as a pending approval and a
human is notified. Approving it issues a one-shot capability, so the agent's
retry succeeds:

```ts
const conduit = new Conduit({ rules, notifier: new WebhookNotifier(SLACK_URL) });

// agent hits an `ask` → conduit.run returns needs_approval + approvalId
// a human reviews:
conduit.approveRequest(approvalId, 'user.alice');   // → one-shot grant issued
conduit.rejectRequest(approvalId, 'user.alice');    // → stays blocked
```

`WebhookNotifier` posts a Slack-compatible message; `ConsoleNotifier` is the
local default. Approvals are also exposed over the control-plane API.

---

## Compliance export

Turn the audit log into auditor-ready evidence — the full event list, the
hash-chain verification, and a summary, in one self-certifying report:

```ts
const report = buildComplianceReport(conduit.auditEntries(), conduit.verifyAudit());
console.log(formatComplianceReport(report));   // human-readable text
```

The control plane serves it at `/api/compliance-report` (JSON) and
`/api/compliance-report.txt`.

---

## Discovery

"Software for agents" starts before sign-up: an agent must be able to **land on
a service and figure out what it can do** — machine-readably, with no human
reading docs. conduit serves two unauthenticated discovery routes:

```bash
GET /.well-known/agent-manifest.json   # the human-free onboarding runbook
GET /openapi.json                      # a full OpenAPI 3.1 contract
```

The manifest names conduit's three primitives, its authentication scheme, the
MCP server, and — critically — an ordered, machine-readable `onboarding` runbook:
*register → request a capability → authorize*. An agent reads the manifest, then
follows the steps below entirely on its own.

```ts
const manifest = await fetch(`${base}/.well-known/agent-manifest.json`).then((r) => r.json());
for (const step of manifest.onboarding.steps) {
  // step.method, step.path, step.body — everything needed to self-onboard
}
```

Both routes stay public even in commercial mode — an agent can discover conduit
*before* it holds any credential.

---

## Self-service onboarding

Once an agent has discovered conduit, it can **sign up and start using it —
without a human in the loop**. conduit makes that the normal path:

```ts
const conduit = new Conduit({
  rules: [{ action: 'payment.*', behavior: 'ask' }],
  selfServe: {
    autoApproveActions: ['web.*', 'payment.*'],
    maxBudget: 50,            // bigger asks escalate to a human
    maxInvocations: 5,
  },
});

// 1. the agent signs itself up — gets a token, issued exactly once
const { token } = conduit.registerAgent({ agentId: 'agent.shopper' });

// 2. the agent requests its own capability, authenticating with that token
const result = conduit.requestCapability('agent.shopper', token, {
  action: 'payment.charge',
  constraints: { budget: { currency: 'USD', limit: 40 }, maxInvocations: 3 },
});
// → { status: 'granted', capability }   — fits the policy, no human touched it
// → { status: 'pending', approvalId }   — exceeds the policy, parked for a human
// → { status: 'rejected', reason }      — denied by a rule, or bad token
```

The token is hashed (SHA-256) before storage — a leaked database can't
impersonate an agent. A request inside the `selfServe` bounds is granted
programmatically; anything beyond them is parked for human approval, and
approving it issues exactly the capability that was asked for. Omit `selfServe`
entirely and every request needs a human — onboarding is opt-in.

---

## conduit as an MCP server

conduit is itself *software for agents*. Run it as an MCP server and any
MCP-capable harness can govern itself programmatically — no human, no UI:

```bash
claude mcp add conduit -- bun run /abs/path/to/conduit/mcp/index.ts
```

Exposed tools: `register_agent`, `request_capability`, `authorize`,
`grant_capability`, `revoke_capability`, `list_capabilities`,
`get_audit_trail`, `verify_audit`. An agent can register itself and request
its own capabilities entirely over MCP — no human, no UI. Two transports —
STDIO (`mcp/index.ts`) and HTTP/SSE (`mcp/http.ts`) for remote hosting.

---

## Persistence

Pass a persistence backend and the audit log, capabilities, and budget usage
survive restarts — the hash chain continues unbroken:

```ts
new Conduit({ persistence: new SqlitePersistence('conduit.db') }); // local
new Conduit({ persistence: await pg.init() });                     // hosted
```

`SqlitePersistence` and `PostgresPersistence` satisfy the same
`ConduitPersistence` interface — local installs use SQLite, the hosted control
plane uses Postgres.

---

## Control plane

The hosted layer — a REST API and dashboard for managing policy, capabilities,
approvals, and audit across a team:

```bash
bun run control-plane     # → http://localhost:4000
DATABASE_URL=postgres://... CONDUIT_API_KEY=secret bun run control-plane
```

### Commercial mode

The open-source kernel is free. The hosted control plane is the commercial
layer: set `CONDUIT_ADMIN_KEY` and conduit runs multi-tenant — accounts, API
keys, usage metering, and plan quotas:

```bash
CONDUIT_ADMIN_KEY=secret bun run control-plane
```

Each account gets an API key; `/api/*` calls authenticate with it, and metered
routes count against the account's monthly plan — Free (10k authorizations),
Team ($99/mo, 1M), Enterprise (custom, unlimited). An over-quota call returns
HTTP 402 until the plan is upgraded. Usage scales with how much agents *act*,
not with seats.

---

## Architecture

```
kernel/
  types.ts        core types — AuthorizationRequest, AuthorizationDecision
  match.ts        glob action matching
  permissions.ts  PermissionEngine — allow / deny / ask rules
  capability.ts   CapabilityStore — scoped, budgeted, rate-limited grants
  audit.ts        AuditLog — hash-chained, tamper-evident
  approval.ts     ApprovalQueue + notifiers — human-in-the-loop
  registry.ts     AgentRegistry — human-free agent sign-up + tokens
  persistence.ts  ConduitPersistence + SqlitePersistence
  postgres.ts     PostgresPersistence — the hosted backend
  export.ts       compliance reports from the audit log
  wrap.ts         governTool — one-line tool governance
  conduit.ts      Conduit — the kernel facade / SDK
index.ts          package entry — import { Conduit } from 'conduit'
mcp/              conduit as an MCP server — stdio + HTTP/SSE
control-plane/    hosted REST API + dashboard + billing (commercial layer)
  discovery.ts    agent manifest + OpenAPI 3.1 — machine-readable discovery
web/              the landing page (dark technical site)
cli/              offline demo + tamper demo
examples/         a live Claude agent governed by conduit
tests/            kernel + control-plane test suites
```

Stack: TypeScript on Bun. Kernel dependencies: `zod` only.

---

## Status

v0.1 — kernel, approvals, machine-readable discovery (agent manifest + OpenAPI
3.1), self-service agent onboarding, MCP server (stdio + HTTP), persistence
(SQLite + Postgres), control plane with usage metering and plan quotas,
compliance export, an installable SDK, a landing page, and a full test suite are
all working. Open-source core; the hosted control plane is the commercial layer.

## License

MIT
