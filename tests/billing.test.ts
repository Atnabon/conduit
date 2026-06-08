import { describe, expect, test } from 'bun:test';
import { Conduit } from '../kernel/conduit.ts';
import { createControlPlane } from '../control-plane/api.ts';
import { AccountStore, PLANS, SqliteBillingPersistence } from '../control-plane/billing.ts';

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`http://x${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

const get = (path: string, headers: Record<string, string> = {}) =>
  new Request(`http://x${path}`, { headers });

async function readJson<T = unknown>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

describe('AccountStore', () => {
  test('createAccount issues a key that authenticates', () => {
    const store = new AccountStore();
    const { account, apiKey } = store.createAccount('Acme', 'team');
    expect(apiKey).toMatch(/^ck_/);
    expect(account.keyHash).not.toBe(apiKey); // only the hash is stored
    expect(store.authenticate(apiKey)?.id).toBe(account.id);
  });

  test('a wrong key does not authenticate', () => {
    const store = new AccountStore();
    store.createAccount('Acme');
    expect(store.authenticate('ck_wrong')).toBeNull();
  });

  test('metering counts authorizations against the current period', () => {
    const store = new AccountStore();
    const { account } = store.createAccount('Acme', 'free');
    store.recordAuthorization(account.id);
    store.recordAuthorization(account.id);
    const summary = store.summary(account.id);
    expect(summary?.authorizations).toBe(2);
    expect(summary?.remaining).toBe(PLANS.free.monthlyAuthorizations - 2);
    expect(summary?.overQuota).toBe(false);
  });

  test('an account is over quota once its plan limit is reached', () => {
    const store = new AccountStore();
    const { account } = store.createAccount('Acme', 'free');
    for (let i = 0; i < PLANS.free.monthlyAuthorizations; i++) {
      store.recordAuthorization(account.id);
    }
    expect(store.summary(account.id)?.overQuota).toBe(true);
  });

  test('enterprise accounts are never over quota', () => {
    const store = new AccountStore();
    const { account } = store.createAccount('BigCo', 'enterprise');
    for (let i = 0; i < 100_000; i++) store.recordAuthorization(account.id);
    expect(store.summary(account.id)?.overQuota).toBe(false);
  });

  test('setPlan upgrades an account', () => {
    const store = new AccountStore();
    const { account } = store.createAccount('Acme', 'free');
    expect(store.setPlan(account.id, 'team')?.plan).toBe('team');
  });

  test('accounts and usage survive a restart via SQLite', () => {
    const persistence = new SqliteBillingPersistence(':memory:');
    const first = new AccountStore({ persistence });
    const { account, apiKey } = first.createAccount('Acme', 'team');
    first.recordAuthorization(account.id);

    const second = new AccountStore({ persistence });
    expect(second.authenticate(apiKey)?.name).toBe('Acme');
    expect(second.summary(account.id)?.authorizations).toBe(1);
    persistence.close();
  });
});

describe('control plane — commercial mode', () => {
  function setup() {
    const conduit = new Conduit({ rules: [{ action: 'web.*', behavior: 'allow' }] });
    const accounts = new AccountStore();
    const handler = createControlPlane(conduit, { accounts, adminKey: 'admin-secret' });
    return { conduit, accounts, handler };
  }

  test('the plan catalog is public', async () => {
    const { handler } = setup();
    const res = await handler(get('/api/plans'));
    expect(res.status).toBe(200);
    expect(await readJson<unknown[]>(res)).toHaveLength(3);
  });

  test('creating an account requires the admin key', async () => {
    const { handler } = setup();
    const denied = await handler(post('/api/accounts', { name: 'Acme' }));
    expect(denied.status).toBe(401);

    const ok = await handler(
      post('/api/accounts', { name: 'Acme', plan: 'team' }, { authorization: 'Bearer admin-secret' }),
    );
    expect(ok.status).toBe(201);
    expect((await readJson<{ apiKey: string }>(ok)).apiKey).toMatch(/^ck_/);
  });

  test('an account API key authorizes /api/* and a missing key is 401', async () => {
    const { handler } = setup();
    const created = await handler(
      post('/api/accounts', { name: 'Acme' }, { authorization: 'Bearer admin-secret' }),
    );
    const { apiKey } = await readJson<{ apiKey: string }>(created);

    const unauth = await handler(get('/api/rules'));
    expect(unauth.status).toBe(401);

    const authed = await handler(get('/api/rules', { authorization: `Bearer ${apiKey}` }));
    expect(authed.status).toBe(200);
  });

  test('a metered call by an over-quota account is refused with 402', async () => {
    const { accounts, handler } = setup();
    const { account, apiKey } = accounts.createAccount('Acme', 'free');
    for (let i = 0; i < PLANS.free.monthlyAuthorizations; i++) {
      accounts.recordAuthorization(account.id);
    }
    const res = await handler(
      post(
        '/api/authorize',
        { agentId: 'a', action: 'web.search' },
        { authorization: `Bearer ${apiKey}` },
      ),
    );
    expect(res.status).toBe(402);
  });

  test('a metered call increments the account usage counter', async () => {
    const { accounts, handler } = setup();
    const { account, apiKey } = accounts.createAccount('Acme', 'free');
    await handler(
      post(
        '/api/authorize',
        { agentId: 'a', action: 'web.search' },
        { authorization: `Bearer ${apiKey}` },
      ),
    );
    expect(accounts.summary(account.id)?.authorizations).toBe(1);
  });
});
