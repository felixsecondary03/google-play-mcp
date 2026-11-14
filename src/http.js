// @ts-check
import crypto from 'node:crypto';
import express from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SERVER_NAME, SERVER_VERSION } from './server.js';

/**
 * @param {string} a
 * @param {string} b
 */
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/**
 * Express app serving MCP over Streamable HTTP (stateless: a fresh server per request).
 *
 * Endpoints:
 *   POST /mcp            Authorization: Bearer <MCP_AUTH_TOKEN>
 *   POST /mcp/<token>    token in the URL, for clients that cannot send headers (e.g. claude.ai custom connectors)
 *   GET  /health
 *
 * @param {{ createServer: () => import('@modelcontextprotocol/sdk/server/mcp.js').McpServer, authToken?: string, status?: () => object }} opts
 */
export function createHttpApp({ createServer, authToken, status }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '4mb' }));

  app.get(['/', '/health'], (_req, res) => {
    res.json({ name: SERVER_NAME, version: SERVER_VERSION, ok: true, ...(status ? status() : {}) });
  });

  /** @type {import('express').RequestHandler} */
  const auth = (req, res, next) => {
    if (!authToken) return next();
    const header = req.headers.authorization ?? '';
    const bearer = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
    const pathToken = typeof req.params.token === 'string' ? req.params.token : '';
    if ((bearer && safeEqual(bearer, authToken)) || (pathToken && safeEqual(pathToken, authToken))) return next();
    res.status(401).set('WWW-Authenticate', 'Bearer').json({
      jsonrpc: '2.0',
      error: { code: -32001, message: 'Unauthorized: invalid or missing MCP auth token' },
      id: null,
    });
  };

  /** @type {import('express').RequestHandler} */
  const handle = async (req, res) => {
    const server = createServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error('MCP request failed:', err);
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
      }
    }
  };

  /** @type {import('express').RequestHandler} */
  const methodNotAllowed = (_req, res) => {
    res.status(405).set('Allow', 'POST').json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method not allowed: this server is stateless, use POST.' },
      id: null,
    });
  };

  for (const path of ['/mcp', '/mcp/:token']) {
    app.post(path, auth, handle);
    app.get(path, auth, methodNotAllowed);
    app.delete(path, auth, methodNotAllowed);
  }
  return app;
}
