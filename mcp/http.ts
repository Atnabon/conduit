#!/usr/bin/env bun
/**
 * conduit MCP server — HTTP entrypoint (for remote hosting).
 *
 * Serves the same six conduit tools as the STDIO server, over the modern
 * Streamable HTTP transport plus the legacy SSE transport. Structure mirrors
 * source-code-full/mcp-server/src/http.ts.
 *
 * Endpoints:
 *   POST/GET/DELETE /mcp   — Streamable HTTP (modern MCP clients)
 *   GET             /sse   — legacy SSE transport
 *   POST            /messages?sessionId=…  — legacy SSE message channel
 *   GET             /health
 *
 * Environment:
 *   CONDUIT_HTTP_PORT  — port (default 4100)
 *   CONDUIT_DB         — SQLite path (default conduit.db)
 *   MCP_API_KEY        — optional bearer token for all routes except /health
 *
 * Usage:
 *   bun run mcp/http.ts
 */

import { randomUUID } from 'node:crypto';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express from 'express';
import { Conduit, SqlitePersistence } from '../kernel/index.ts';
import { createConduitServer } from './server.ts';

const PORT = Number(process.env.CONDUIT_HTTP_PORT ?? '4100');
const API_KEY = process.env.MCP_API_KEY;

const conduit = new Conduit({
  persistence: new SqlitePersistence(process.env.CONDUIT_DB ?? 'conduit.db'),
  defaultBehavior: 'ask',
});

function authMiddleware(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
): void {
  if (!API_KEY || req.path === '/health') {
    next();
    return;
  }
  if (req.headers.authorization !== `Bearer ${API_KEY}`) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
}

/** Modern Streamable HTTP transport — POST for JSON-RPC, GET for the SSE stream. */
function mountStreamableHTTP(app: express.Express): void {
  const transports = new Map<string, StreamableHTTPServerTransport>();

  app.post('/mcp', async (req, res) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    let transport = sessionId ? transports.get(sessionId) : undefined;

    if (!transport) {
      transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
      transport.onclose = () => {
        if (transport?.sessionId) transports.delete(transport.sessionId);
      };
      await createConduitServer(conduit).connect(transport);
    }

    await transport.handleRequest(req, res, req.body);
    if (transport.sessionId && !transports.has(transport.sessionId)) {
      transports.set(transport.sessionId, transport);
    }
  });

  app.get('/mcp', async (req, res) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    const transport = sessionId ? transports.get(sessionId) : undefined;
    if (!transport) {
      res.status(400).json({ error: 'Invalid or missing session ID' });
      return;
    }
    await transport.handleRequest(req, res);
  });

  app.delete('/mcp', async (req, res) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    const transport = sessionId ? transports.get(sessionId) : undefined;
    if (transport) {
      await transport.close();
      transports.delete(sessionId as string);
    }
    res.status(200).json({ ok: true });
  });
}

/** Legacy SSE transport — for older MCP clients. */
function mountLegacySSE(app: express.Express): void {
  const transports = new Map<string, SSEServerTransport>();

  app.get('/sse', async (_req, res) => {
    const transport = new SSEServerTransport('/messages', res);
    transports.set(transport.sessionId, transport);
    transport.onclose = () => transports.delete(transport.sessionId);
    await createConduitServer(conduit).connect(transport);
  });

  app.post('/messages', async (req, res) => {
    const transport = transports.get(req.query.sessionId as string);
    if (!transport) {
      res.status(400).json({ error: 'Unknown session' });
      return;
    }
    await transport.handlePostMessage(req, res, req.body);
  });
}

function main(): void {
  const app = express();
  app.use(express.json());
  app.use(authMiddleware);

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', server: 'conduit', version: '0.1.0' });
  });

  mountStreamableHTTP(app);
  mountLegacySSE(app);

  app.listen(PORT, () => {
    process.stdout.write(
      `conduit MCP server (HTTP) on :${PORT}\n` +
        `  Streamable HTTP: POST/GET http://localhost:${PORT}/mcp\n` +
        `  Legacy SSE:      GET http://localhost:${PORT}/sse\n` +
        `  Health:          GET http://localhost:${PORT}/health\n` +
        (API_KEY ? '  Auth: Bearer token required\n' : ''),
    );
  });
}

main();
