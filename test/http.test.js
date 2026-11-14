import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createHttpApp } from '../src/http.js';
import { createServer } from '../src/server.js';

const TOKEN = 'secret-token-123';

async function start() {
  const app = createHttpApp({
    createServer: () => createServer({ getClients: () => { throw new Error('no creds'); } }),
    authToken: TOKEN,
  });
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

test('HTTP transport enforces the auth token', async (t) => {
  const { server, base } = await start();
  t.after(() => server.close());

  const health = await (await fetch(`${base}/health`)).json();
  assert.equal(health.ok, true);

  const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '1' } } };
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  assert.equal((await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify(init) })).status, 401);
  assert.equal((await fetch(`${base}/mcp/wrong`, { method: 'POST', headers, body: JSON.stringify(init) })).status, 401);

  // Bearer header
  const c1 = new Client({ name: 't', version: '1' });
  await c1.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } } }));
  assert.ok((await c1.listTools()).tools.length > 20);
  await c1.close();

  // Token in path
  const c2 = new Client({ name: 't', version: '1' });
  await c2.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp/${TOKEN}`)));
  const res = await c2.callTool({ name: 'list_apps', arguments: {} });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /no creds/);
  await c2.close();
});
