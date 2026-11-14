#!/usr/bin/env node
// @ts-check
import { parseArgs } from 'node:util';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadCredentials } from './credentials.js';
import { createGoogleClients } from './google.js';
import { createServer, SERVER_VERSION } from './server.js';
import { createHttpApp } from './http.js';

const HELP = `google-play-mcp ${SERVER_VERSION} — MCP server for the Google Play Console

Usage:
  google-play-mcp [--key-file key.json]            stdio transport (Claude Desktop, Claude Code, Cursor, ...)
  google-play-mcp --http [--port 8080]             Streamable HTTP transport on /mcp

Options:
  --key-file <path>     Service-account JSON key (or use env vars below)
  --http                Serve over HTTP instead of stdio
  --port <n>            HTTP port (default: $PORT or 8080)
  --host <addr>         HTTP bind address (default 0.0.0.0)
  --read-only           Only expose tools that do not change anything
  --check               Verify credentials + API access and exit

Environment:
  GOOGLE_CREDENTIALS_JSON         Content of the JSON key (raw JSON or base64)
  GOOGLE_APPLICATION_CREDENTIALS  Path to the JSON key file
  GOOGLE_PLAY_PACKAGE_NAME        Default package name (optional)
  PLAY_DEVELOPER_ID               Developer account id for list_users (optional)
  MCP_AUTH_TOKEN                  Required in HTTP mode: clients send "Authorization: Bearer <token>" or call /mcp/<token>
  MCP_READ_ONLY=true              Same as --read-only
  ALLOW_UNAUTHENTICATED=true      Allow HTTP mode without MCP_AUTH_TOKEN (NOT recommended)
`;

const { values } = parseArgs({
  options: {
    'key-file': { type: 'string' },
    http: { type: 'boolean', default: false },
    port: { type: 'string' },
    host: { type: 'string' },
    'read-only': { type: 'boolean', default: false },
    check: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
  strict: true,
});

if (values.help) {
  process.stdout.write(HELP);
  process.exit(0);
}

const env = process.env;
const truthy = (/** @type {string|undefined} */ v) => /^(1|true|yes|on)$/i.test(v ?? '');

/** @type {import('./google.js').GoogleClients | undefined} */
let clients;
/** @type {string | undefined} */
let credentialError;
/** @type {string | undefined} */
let credentialSource;
try {
  const { key, source } = loadCredentials({ keyFile: values['key-file'] });
  clients = createGoogleClients(key);
  credentialSource = source;
  console.error(`[google-play-mcp] Using service account ${key.client_email} (from ${source})`);
} catch (err) {
  credentialError = /** @type {Error} */ (err).message;
  console.error(`[google-play-mcp] WARNING: ${credentialError}`);
}

/** @type {import('./server.js').ServerConfig} */
const config = {
  getClients: () => {
    if (!clients) throw new Error(credentialError ?? 'Google credentials not configured.');
    return clients;
  },
  defaultPackageName: env.GOOGLE_PLAY_PACKAGE_NAME || undefined,
  developerId: env.PLAY_DEVELOPER_ID || undefined,
  readOnly: values['read-only'] || truthy(env.MCP_READ_ONLY),
};

if (values.check) {
  await runCheck();
} else if (values.http) {
  const authToken = env.MCP_AUTH_TOKEN?.trim() || undefined;
  if (!authToken && !truthy(env.ALLOW_UNAUTHENTICATED)) {
    console.error(
      '[google-play-mcp] Refusing to start HTTP mode without MCP_AUTH_TOKEN: anybody who finds the URL could control your Play Console.\n' +
        '  Set MCP_AUTH_TOKEN to a long random string (e.g. `openssl rand -hex 32`), or ALLOW_UNAUTHENTICATED=true to override.'
    );
    process.exit(1);
  }
  const port = Number(values.port ?? env.PORT ?? 8080);
  const host = values.host ?? env.HOST ?? '0.0.0.0';
  const app = createHttpApp({
    createServer: () => createServer(config),
    authToken,
    status: () => ({
      credentials: clients ? `ok (${clients.clientEmail})` : `missing: ${credentialError}`,
      readOnly: !!config.readOnly,
      auth: authToken ? 'token' : 'none',
    }),
  });
  const httpServer = app.listen(port, host, () => {
    console.error(`[google-play-mcp] Streamable HTTP listening on http://${host}:${port}/mcp${config.readOnly ? ' (read-only)' : ''}`);
  });
  const shutdown = () => httpServer.close(() => process.exit(0));
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
} else {
  const server = createServer(config);
  await server.connect(new StdioServerTransport());
  console.error(`[google-play-mcp] ready on stdio${config.readOnly ? ' (read-only)' : ''}`);
}

async function runCheck() {
  if (!clients) {
    console.error(`✗ Credentials: ${credentialError}`);
    process.exit(1);
  }
  const { describeGoogleError } = await import('./google.js');
  console.error(`✓ Credentials parsed (${credentialSource}): ${clients.clientEmail}`);
  let ok = true;
  try {
    const res = await clients.reporting.apps.search({ pageSize: 100 });
    const apps = res.data.apps ?? [];
    console.error(`✓ Reporting API: ${apps.length} app(s) accessible`);
    for (const a of apps) console.error(`    ${a.packageName}  ${a.displayName ?? ''}`);
  } catch (err) {
    ok = false;
    console.error(`✗ Reporting API (list_apps, vitals): ${describeGoogleError(err, clients.clientEmail)}`);
  }
  const pkg = config.defaultPackageName;
  if (pkg) {
    try {
      const edit = await clients.publisher.edits.insert({ packageName: pkg, requestBody: {} });
      await clients.publisher.edits.delete({ packageName: pkg, editId: /** @type {string} */ (edit.data.id) });
      console.error(`✓ Android Publisher API: access to ${pkg} works`);
    } catch (err) {
      ok = false;
      console.error(`✗ Android Publisher API (${pkg}): ${describeGoogleError(err, clients.clientEmail)}`);
    }
  } else {
    console.error('  (set GOOGLE_PLAY_PACKAGE_NAME to also test the Android Publisher API for one app)');
  }
  process.exit(ok ? 0 : 1);
}
