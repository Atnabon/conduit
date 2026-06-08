# conduit — 60-second quickstart

The authorization kernel for AI agents. Wrap every tool call through it and you
get permissions, scoped capabilities, a tamper-evident audit log, and human-free
agent onboarding — for free.

## Install

```bash
bun add conduit
```

conduit is Bun-native (it uses `bun:sqlite`, `Bun.sql`, and `Bun.serve` for its
persistence and hosting layers). The kernel core depends only on `zod`.

## 1. Govern a tool call

The universal integration — one `conduit.run(...)` around tool execution:

```ts
import { Conduit } from 'conduit';

const conduit = new Conduit({
  rules: [
    { action: 'web.*',     behavior: 'allow' },
    { action: 'system.*',  behavior: 'deny'  },
    { action: 'payment.*', behavior: 'ask'   },
  ],
});

const outcome = await conduit.run(
  { agentId: 'agent.shopper', action: 'payment.charge', input,
    cost: { currency: 'USD', amount: 80 } },
  async () => chargeTheCard(input),
);

if (outcome.status === 'allowed')             { /* it ran */ }
else if (outcome.status === 'denied')         { /* blocked */ }
else if (outcome.status === 'needs_approval') { /* outcome.approvalId */ }
```

`deny` always wins. An `ask` action is blocked until a capability covers it or a
human approves it.

## 2. Grant scoped autonomy

A capability lets an agent act without a human — safely, because every limit is
explicit:

```ts
conduit.grant({
  agentId: 'agent.shopper',
  action: 'payment.charge',
  constraints: {
    budget: { currency: 'USD', limit: 200 },
    maxInvocations: 3,
    rateLimit: { maxInvocations: 1, windowMs: 60_000 },
  },
  grantedBy: 'user.owner',
  expiresAt: Date.now() + 60 * 60 * 1000,
});
```

## 3. Let agents onboard themselves

No human in the loop — an agent registers, gets a token, and requests its own
capabilities:

```ts
const conduit = new Conduit({
  rules: [{ action: 'payment.*', behavior: 'ask' }],
  selfServe: { autoApproveActions: ['payment.*'], maxBudget: 50, maxInvocations: 5 },
});

const { token } = conduit.registerAgent({ agentId: 'agent.shopper' });

const result = conduit.requestCapability('agent.shopper', token, {
  action: 'payment.charge',
  constraints: { budget: { currency: 'USD', limit: 40 } },
});
// → granted | pending (parked for a human) | rejected
```

## 4. Prove what happened

```ts
conduit.verifyAudit();                     // → { valid: true, length: 12 }
conduit.auditEntries();                    // the full hash-chained event list
```

## Next

- `bun run demo` — a simulated agent governed by the kernel
- `bun run mcp` — conduit as an MCP server, so any harness governs itself
- `bun run control-plane` — the hosted API + dashboard
- Full reference: [README.md](./README.md)
