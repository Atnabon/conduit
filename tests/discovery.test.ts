import { describe, expect, test } from 'bun:test';
import { Conduit } from '../kernel/conduit.ts';
import { createControlPlane } from '../control-plane/api.ts';
import { AccountStore } from '../control-plane/billing.ts';
import {
  buildAgentManifest,
  buildOpenApiSpec,
  CONDUIT_VERSION,
} from '../control-plane/discovery.ts';

const get = (path: string, headers: Record<string, string> = {}) =>
  new Request(`http://x${path}`, { headers });

async function readJson<T = unknown>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

describe('agent manifest', () => {
  test('describes conduit and its three primitives', () => {
    const m = buildAgentManifest();
    expect(m.kind).toBe('agent-authorization-service');
    expect(m.conduit).toBe(CONDUIT_VERSION);
    const primitives = m.primitives as Record<string, string>;
    expect(Object.keys(primitives).sort()).toEqual(['audit', 'capabilities', 'permissions']);
  });

  test('lays out a three-step, human-free onboarding runbook', () => {
    const onboarding = buildAgentManifest().onboarding as {
      steps: { step: number; method: string; path: string }[];
    };
    expect(onboarding.steps).toHaveLength(3);
    expect(onboarding.steps.map((s) => s.path)).toEqual([
      '/api/agents',
      '/api/capability-requests',
      '/api/authorize',
    ]);
    expect(onboarding.steps.every((s) => s.method === 'POST')).toBe(true);
  });

  test('reflects open vs commercial authentication mode', () => {
    expect((buildAgentManifest({ commercial: false }).authentication as { mode: string }).mode).toBe('open');
    expect((buildAgentManifest({ commercial: true }).authentication as { mode: string }).mode).toBe(
      'commercial',
    );
  });

  test('endpoint index is derived from the OpenAPI paths', () => {
    const m = buildAgentManifest();
    const endpoints = m.endpoints as { method: string; path: string }[];
    const specPaths = Object.keys((buildOpenApiSpec().paths as object));
    for (const path of specPaths) {
      expect(endpoints.some((e) => e.path === path)).toBe(true);
    }
  });

  test('advertises the MCP server and its eight tools', () => {
    const mcp = buildAgentManifest().mcp as { tools: string[] };
    expect(mcp.tools).toHaveLength(8);
    expect(mcp.tools).toContain('register_agent');
    expect(mcp.tools).toContain('request_capability');
  });
});

describe('OpenAPI spec', () => {
  test('is a valid 3.1 document with info and paths', () => {
    const spec = buildOpenApiSpec();
    expect(spec.openapi).toBe('3.1.0');
    expect((spec.info as { version: string }).version).toBe(CONDUIT_VERSION);
    expect(Object.keys(spec.paths as object).length).toBeGreaterThan(10);
  });

  test('documents the core onboarding and authorization routes', () => {
    const paths = buildOpenApiSpec().paths as Record<string, Record<string, unknown>>;
    expect(paths['/api/agents'].post).toBeDefined();
    expect(paths['/api/capability-requests'].post).toBeDefined();
    expect(paths['/api/authorize'].post).toBeDefined();
  });
});

describe('discovery routes', () => {
  function setup(commercial = false) {
    const conduit = new Conduit({ rules: [{ action: 'web.*', behavior: 'allow' }] });
    const options = commercial
      ? { accounts: new AccountStore(), adminKey: 'admin-secret' }
      : {};
    return createControlPlane(conduit, options);
  }

  test('serves the manifest unauthenticated', async () => {
    const handler = setup();
    const res = await handler(get('/.well-known/agent-manifest.json'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect((await readJson<{ name: string }>(res)).name).toBe('conduit');
  });

  test('serves the OpenAPI spec unauthenticated', async () => {
    const handler = setup();
    const res = await handler(get('/openapi.json'));
    expect(res.status).toBe(200);
    expect((await readJson<{ openapi: string }>(res)).openapi).toBe('3.1.0');
  });

  test('discovery stays public even in commercial mode', async () => {
    const handler = setup(true);
    // No account key — these must still resolve, so an agent can discover
    // conduit before it has signed up.
    const manifest = await handler(get('/.well-known/agent-manifest.json'));
    const openapi = await handler(get('/openapi.json'));
    expect(manifest.status).toBe(200);
    expect(openapi.status).toBe(200);
  });

  test('manifest reports commercial auth when the control plane is multi-tenant', async () => {
    const handler = setup(true);
    const res = await handler(get('/.well-known/agent-manifest.json'));
    const auth = (await readJson<{ authentication: { mode: string } }>(res)).authentication;
    expect(auth.mode).toBe('commercial');
  });
});
