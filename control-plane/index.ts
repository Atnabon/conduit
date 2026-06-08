#!/usr/bin/env bun
/**
 * conduit control plane — HTTP entrypoint.
 *
 * Serves the REST API and the dashboard. The kernel is backed by SQLite by
 * default, or Postgres when DATABASE_URL is set (the hosted configuration).
 *
 * Usage:
 *   bun run control-plane/index.ts
 *   CONDUIT_PORT=4000 CONDUIT_API_KEY=secret bun run control-plane/index.ts
 *   DATABASE_URL=postgres://... bun run control-plane/index.ts
 *
 * Commercial mode — multi-tenant accounts, metering, and plan quotas:
 *   CONDUIT_ADMIN_KEY=secret bun run control-plane/index.ts
 */

import { Conduit, PostgresPersistence, SqlitePersistence } from '../kernel/index.ts';
import { createControlPlane } from './api.ts';
import { AccountStore, SqliteBillingPersistence } from './billing.ts';

async function buildConduit(): Promise<Conduit> {
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl) {
    const persistence = new PostgresPersistence(databaseUrl);
    await persistence.init();
    return new Conduit({ persistence, defaultBehavior: 'ask' });
  }
  return new Conduit({
    persistence: new SqlitePersistence(process.env.CONDUIT_DB ?? 'conduit.db'),
    defaultBehavior: 'ask',
  });
}

async function main(): Promise<void> {
  const port = Number(process.env.CONDUIT_PORT ?? '4000');
  const apiKey = process.env.CONDUIT_API_KEY;
  const adminKey = process.env.CONDUIT_ADMIN_KEY;
  const conduit = await buildConduit();

  // Commercial mode is enabled by setting an admin key — it turns on
  // multi-tenant accounts, usage metering, and plan-quota enforcement.
  const accounts = adminKey
    ? new AccountStore({
        persistence: new SqliteBillingPersistence(process.env.CONDUIT_BILLING_DB ?? 'conduit-billing.db'),
      })
    : undefined;

  const handler = createControlPlane(conduit, { apiKey, accounts, adminKey });

  Bun.serve({ port, fetch: handler });
  process.stdout.write(
    `conduit control plane → http://localhost:${port}\n` +
      (accounts
        ? '  commercial mode — account API keys required, usage metered\n'
        : apiKey
          ? '  api key required for /api/*\n'
          : '  no api key set (open access)\n'),
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`fatal: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
