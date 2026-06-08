#!/usr/bin/env bun
/**
 * conduit landing page — static dev server.
 *
 * Serves the marketing site from this directory. Production deploys this as
 * plain static files behind any CDN; this server is just for local preview.
 *
 * Usage: bun run web/serve.ts   (or: bun run site)
 */

import { file } from 'bun';
import { join } from 'node:path';

const ROOT = import.meta.dir;
const port = Number(process.env.SITE_PORT ?? '4200');

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
};

Bun.serve({
  port,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname === '/' ? '/index.html' : url.pathname;
    // Confine every request to this directory — no path traversal.
    const resolved = join(ROOT, path);
    if (!resolved.startsWith(ROOT)) return new Response('forbidden', { status: 403 });

    const asset = file(resolved);
    if (!(await asset.exists())) return new Response('not found', { status: 404 });

    const ext = path.slice(path.lastIndexOf('.'));
    return new Response(asset, {
      headers: { 'content-type': CONTENT_TYPES[ext] ?? 'application/octet-stream' },
    });
  },
});

process.stdout.write(`conduit site → http://localhost:${port}\n`);
