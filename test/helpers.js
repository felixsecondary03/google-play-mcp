import crypto from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.js';

export function fakeKey() {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  return {
    type: 'service_account',
    project_id: 'demo',
    client_email: 'play-bot@demo.iam.gserviceaccount.com',
    private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}

/** Records calls; `handlers` maps "edits.tracks.get" → fn(params) returning data. */
export function fakeApi(handlers) {
  const calls = [];
  const make = (path) =>
    new Proxy(function () {}, {
      get: (_t, prop) => make(path ? `${path}.${String(prop)}` : String(prop)),
      apply: async (_t, _this, [params]) => {
        calls.push({ method: path, params });
        const h = handlers[path];
        if (!h) throw new Error(`unexpected call ${path}`);
        return { data: await h(params) };
      },
    });
  return { api: make(''), calls };
}

export async function connect(config) {
  const server = createServer(config);
  const client = new Client({ name: 'test', version: '1.0.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

export function text(result) {
  return result.content.map((c) => c.text).join('\n');
}
