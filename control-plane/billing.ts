import { Database } from 'bun:sqlite';
import { createHash, randomUUID } from 'node:crypto';

// ─────────────────────────────────────────────────────────────────────────────
// Billing — the commercial layer over the hosted control plane.
//
// The kernel is open source and free. Revenue comes from the hosted control
// plane: teams sign up for an account, get an API key, and are metered on the
// authorization decisions conduit makes for them. Plans cap monthly volume;
// exceeding the cap returns HTTP 402 until the plan is upgraded.
//
// An account's API key is hashed (SHA-256) before storage — the plaintext key
// is shown exactly once, at creation.
// ─────────────────────────────────────────────────────────────────────────────

export type PlanName = 'free' | 'team' | 'enterprise';

export type Plan = {
  name: PlanName;
  label: string;
  /** Authorization decisions included per calendar month. */
  monthlyAuthorizations: number;
  /** List price. Enterprise is custom-priced, shown as 0 here. */
  priceUsdPerMonth: number;
  blurb: string;
};

export const PLANS: Record<PlanName, Plan> = {
  free: {
    name: 'free',
    label: 'Free',
    monthlyAuthorizations: 10_000,
    priceUsdPerMonth: 0,
    blurb: 'For prototypes and side projects. The full kernel, self-hosted, forever free.',
  },
  team: {
    name: 'team',
    label: 'Team',
    monthlyAuthorizations: 1_000_000,
    priceUsdPerMonth: 99,
    blurb: 'For production agents. Hosted control plane, dashboard, and compliance exports.',
  },
  enterprise: {
    name: 'enterprise',
    label: 'Enterprise',
    monthlyAuthorizations: Number.POSITIVE_INFINITY,
    priceUsdPerMonth: 0,
    blurb: 'Unlimited volume, SSO, audit retention SLAs, and a private deployment option.',
  },
};

export type Account = {
  id: string;
  name: string;
  plan: PlanName;
  /** SHA-256 hex digest of the API key. The key itself is never stored. */
  keyHash: string;
  createdAt: number;
};

/** Authorizations consumed by one account in one calendar month. */
export type UsageRecord = { accountId: string; period: string; authorizations: number };

export type UsageSummary = {
  account: Account;
  plan: Plan;
  period: string;
  authorizations: number;
  quota: number;
  remaining: number;
  overQuota: boolean;
};

/** The newly created account paired with its plaintext key — returned once. */
export type AccountCreation = { account: Account; apiKey: string };

function hashKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

/** Calendar-month bucket, e.g. "2026-05". Usage and quotas reset on this boundary. */
export function billingPeriod(now: number = Date.now()): string {
  const d = new Date(now);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** Durable storage for accounts and their monthly usage. */
export interface BillingPersistence {
  loadAccounts(): Account[];
  loadUsage(): UsageRecord[];
  upsertAccount(account: Account): void;
  saveUsage(record: UsageRecord): void;
  close(): void;
}

export type AccountStoreOptions = {
  persistence?: BillingPersistence;
};

/**
 * Holds accounts and their running monthly usage. Metering is the revenue
 * mechanism: `recordAuthorization` increments the current period's counter and
 * `summary` reports whether the account is within its plan's quota.
 */
export class AccountStore {
  private readonly accounts = new Map<string, Account>();
  private readonly usage = new Map<string, UsageRecord>();
  private readonly persistence?: BillingPersistence;

  constructor(options: AccountStoreOptions = {}) {
    this.persistence = options.persistence;
    for (const account of this.persistence?.loadAccounts() ?? []) {
      this.accounts.set(account.id, account);
    }
    for (const record of this.persistence?.loadUsage() ?? []) {
      this.usage.set(`${record.accountId}:${record.period}`, record);
    }
  }

  /** Create an account on a plan and issue its API key. The key is returned once. */
  createAccount(name: string, plan: PlanName = 'free'): AccountCreation {
    if (!name.trim()) throw new Error('account name is required');
    const apiKey = `ck_${randomUUID()}${randomUUID()}`.replace(/-/g, '');
    const account: Account = {
      id: `acct_${randomUUID()}`,
      name,
      plan,
      keyHash: hashKey(apiKey),
      createdAt: Date.now(),
    };
    this.accounts.set(account.id, account);
    this.persistence?.upsertAccount(account);
    return { account, apiKey };
  }

  /** Resolve an API key to its account, or null if no account holds that key. */
  authenticate(apiKey: string): Account | null {
    const keyHash = hashKey(apiKey);
    for (const account of this.accounts.values()) {
      if (account.keyHash === keyHash) return account;
    }
    return null;
  }

  /** Move an account to a different plan. */
  setPlan(accountId: string, plan: PlanName): Account | null {
    const existing = this.accounts.get(accountId);
    if (!existing) return null;
    const updated: Account = { ...existing, plan };
    this.accounts.set(accountId, updated);
    this.persistence?.upsertAccount(updated);
    return updated;
  }

  /** Count one metered authorization against the account's current period. */
  recordAuthorization(accountId: string, now: number = Date.now()): void {
    const period = billingPeriod(now);
    const key = `${accountId}:${period}`;
    const current = this.usage.get(key) ?? { accountId, period, authorizations: 0 };
    const next: UsageRecord = { ...current, authorizations: current.authorizations + 1 };
    this.usage.set(key, next);
    this.persistence?.saveUsage(next);
  }

  /** Current-period usage and quota for an account. */
  summary(accountId: string, now: number = Date.now()): UsageSummary | null {
    const account = this.accounts.get(accountId);
    if (!account) return null;
    const plan = PLANS[account.plan];
    const period = billingPeriod(now);
    const authorizations = this.usage.get(`${accountId}:${period}`)?.authorizations ?? 0;
    const quota = plan.monthlyAuthorizations;
    return {
      account,
      plan,
      period,
      authorizations,
      quota,
      remaining: Math.max(0, quota - authorizations),
      overQuota: authorizations >= quota,
    };
  }

  list(): Account[] {
    return [...this.accounts.values()];
  }
}

// ── SQLite-backed billing persistence ────────────────────────────────────────

type AccountRow = {
  id: string;
  name: string;
  plan: string;
  keyHash: string;
  createdAt: number;
};

type UsageRow = { accountId: string; period: string; authorizations: number };

/** SQLite implementation of `BillingPersistence`. `path` may be `:memory:`. */
export class SqliteBillingPersistence implements BillingPersistence {
  private readonly db: Database;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.run('PRAGMA journal_mode = WAL');
    this.db.run(`
      CREATE TABLE IF NOT EXISTS accounts (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        plan TEXT NOT NULL,
        keyHash TEXT NOT NULL,
        createdAt INTEGER NOT NULL
      )`);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS account_usage (
        accountId TEXT NOT NULL,
        period TEXT NOT NULL,
        authorizations INTEGER NOT NULL,
        PRIMARY KEY (accountId, period)
      )`);
  }

  loadAccounts(): Account[] {
    const rows = this.db.query('SELECT * FROM accounts').all() as AccountRow[];
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      plan: r.plan as PlanName,
      keyHash: r.keyHash,
      createdAt: r.createdAt,
    }));
  }

  loadUsage(): UsageRecord[] {
    return this.db.query('SELECT * FROM account_usage').all() as UsageRow[];
  }

  upsertAccount(account: Account): void {
    this.db
      .query(
        `INSERT INTO accounts (id, name, plan, keyHash, createdAt)
         VALUES ($id, $name, $plan, $keyHash, $createdAt)
         ON CONFLICT(id) DO UPDATE SET name = $name, plan = $plan`,
      )
      .run({
        $id: account.id,
        $name: account.name,
        $plan: account.plan,
        $keyHash: account.keyHash,
        $createdAt: account.createdAt,
      });
  }

  saveUsage(record: UsageRecord): void {
    this.db
      .query(
        `INSERT INTO account_usage (accountId, period, authorizations)
         VALUES ($accountId, $period, $authorizations)
         ON CONFLICT(accountId, period) DO UPDATE SET authorizations = $authorizations`,
      )
      .run({
        $accountId: record.accountId,
        $period: record.period,
        $authorizations: record.authorizations,
      });
  }

  close(): void {
    this.db.close();
  }
}
