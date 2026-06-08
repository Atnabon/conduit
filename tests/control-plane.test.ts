import { describe, expect, test } from 'bun:test';
import { Conduit } from '../kernel/conduit.ts';
import { createControlPlane } from '../control-plane/api.ts';

function setup(apiKey?: string) {
  const conduit = new Conduit({ rules: [{ action: 'web.*', behavior: 'allow' }] });
  return { conduit, handler: createControlPlane(conduit, { apiKey }) };
}

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`http://x${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

async function readJson<T = unknown>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

describe('control plane API', () => {
  test('health check responds', async () => {
    const { handler } = setup();
    const res = await handler(new Request('http://x/health'));
    expect(res.status).toBe(200);
    expect((await readJson<{ ok: boolean }>(res)).ok).toBe(true);
  });

  test('serves the dashboard HTML at /', async () => {
    const { handler } = setup();
    const res = await handler(new Request('http://x/'));
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toContain('conduit');
  });

  test('lists policy rules', async () => {
    const { handler } = setup();
    const res = await handler(new Request('http://x/api/rules'));
    expect(await readJson<unknown[]>(res)).toHaveLength(1);
  });

  test('adds a policy rule', async () => {
    const { conduit, handler } = setup();
    const res = await handler(post('/api/rules', { action: 'payment.*', behavior: 'deny' }));
    expect(res.status).toBe(201);
    expect(conduit.rules().some((r) => r.action === 'payment.*')).toBe(true);
  });

  test('grants and lists a capability', async () => {
    const { handler } = setup();
    const grant = await handler(
      post('/api/capabilities', { agentId: 'a1', action: 'payment.*', grantedBy: 'user' }),
    );
    expect(grant.status).toBe(201);

    const list = await handler(new Request('http://x/api/capabilities?agentId=a1'));
    expect(await readJson<unknown[]>(list)).toHaveLength(1);
  });

  test('revokes a capability', async () => {
    const { handler } = setup();
    const grant = await readJson<{ id: string }>(
      await handler(post('/api/capabilities', { agentId: 'a1', action: 'x.*', grantedBy: 'u' })),
    );
    const res = await handler(post(`/api/capabilities/${grant.id}/revoke`, {}));
    expect((await readJson<{ revoked: boolean }>(res)).revoked).toBe(true);
  });

  test('authorizes an action and records it', async () => {
    const { handler } = setup();
    const res = await handler(post('/api/authorize', { agentId: 'a1', action: 'web.search' }));
    expect((await readJson<{ behavior: string }>(res)).behavior).toBe('allow');

    const audit = await handler(new Request('http://x/api/audit'));
    expect((await readJson<unknown[]>(audit)).length).toBeGreaterThan(0);
  });

  test('verifies the audit chain', async () => {
    const { handler } = setup();
    await handler(post('/api/authorize', { agentId: 'a1', action: 'web.search' }));
    const res = await handler(new Request('http://x/api/audit/verify'));
    expect((await readJson<{ valid: boolean }>(res)).valid).toBe(true);
  });

  test('produces a compliance report', async () => {
    const { handler } = setup();
    await handler(post('/api/authorize', { agentId: 'a1', action: 'web.search' }));
    const res = await handler(new Request('http://x/api/compliance-report'));
    const report = await readJson<{
      integrity: { valid: boolean };
      summary: { decisions: { allow: number } };
    }>(res);
    expect(report.integrity.valid).toBe(true);
    expect(report.summary.decisions.allow).toBe(1);
  });

  test('approves a pending approval over the API', async () => {
    const { conduit, handler } = setup();
    conduit.addRule({ action: 'payment.*', behavior: 'ask' });
    await conduit.run(
      { agentId: 'a1', action: 'payment.charge', input: {} },
      async () => 'charged',
    );

    const pending = await readJson<{ id: string }[]>(
      await handler(new Request('http://x/api/approvals')),
    );
    expect(pending).toHaveLength(1);

    const res = await handler(post(`/api/approvals/${pending[0].id}/approve`, { approvedBy: 'alice' }));
    expect((await readJson<{ status: string }>(res)).status).toBe('approved');
  });

  test('rejects unauthorized requests when an API key is set', async () => {
    const { handler } = setup('secret');
    const denied = await handler(new Request('http://x/api/rules'));
    expect(denied.status).toBe(401);

    const allowed = await handler(
      new Request('http://x/api/rules', { headers: { authorization: 'Bearer secret' } }),
    );
    expect(allowed.status).toBe(200);
  });

  test('invalid input returns a 400', async () => {
    const { handler } = setup();
    const res = await handler(post('/api/capabilities', { agentId: '' }));
    expect(res.status).toBe(400);
  });

  test('an agent registers and self-serves a capability over HTTP', async () => {
    const conduit = new Conduit({
      rules: [{ action: 'web.*', behavior: 'allow' }],
      selfServe: { autoApproveActions: ['web.*'] },
    });
    const handler = createControlPlane(conduit);

    const reg = await handler(post('/api/agents', { agentId: 'agent.a' }));
    expect(reg.status).toBe(201);
    const { token } = await readJson<{ token: string }>(reg);

    const req = await handler(
      post('/api/capability-requests', { agentId: 'agent.a', token, action: 'web.search' }),
    );
    expect(req.status).toBe(201);
    expect((await readJson<{ status: string }>(req)).status).toBe('granted');
  });

  test('a capability request with a bad token is rejected with 403', async () => {
    const conduit = new Conduit({ selfServe: { autoApproveActions: ['web.*'] } });
    const handler = createControlPlane(conduit);
    conduit.registerAgent({ agentId: 'agent.a' });

    const req = await handler(
      post('/api/capability-requests', { agentId: 'agent.a', token: 'agt_bad', action: 'web.search' }),
    );
    expect(req.status).toBe(403);
  });
});
