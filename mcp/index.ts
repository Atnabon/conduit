#!/usr/bin/env bun
/**
 * conduit MCP server — STDIO entrypoint.
 *
 * Run directly, or register with any MCP-capable harness (Claude Code, Claude
 * Desktop, etc.). The kernel is backed by SQLite so capabilities and the audit
 * trail persist across restarts.
 *
 * Usage:
 *   bun run mcp/index.ts
 *   CONDUIT_DB=/path/to/conduit.db bun run mcp/index.ts
 *
 * Register with Claude Code:
 *   claude mcp add conduit -- bun run /abs/path/to/conduit/mcp/index.ts
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Conduit, SqlitePersistence } from '../kernel/index.ts';
import { createConduitServer } from './server.ts';

async function main(): Promise<void> {
  const dbPath = process.env.CONDUIT_DB ?? 'conduit.db';
  const conduit = new Conduit({
    persistence: new SqlitePersistence(dbPath),
    defaultBehavior: 'ask',
  });

  const server = createConduitServer(conduit);
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // STDIO transport owns stdout for JSON-RPC; status goes to stderr.
  process.stderr.write(`conduit MCP server (stdio) started — db: ${dbPath}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`fatal: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
