import test from 'node:test';
import assert from 'node:assert/strict';
import { parseServiceAccountKey, loadCredentials } from '../src/credentials.js';
import { fakeKey } from './helpers.js';

const key = fakeKey();
const json = JSON.stringify(key);

test('parses raw JSON', () => {
  assert.equal(parseServiceAccountKey(json).client_email, key.client_email);
});

test('parses base64 JSON', () => {
  const k = parseServiceAccountKey(Buffer.from(json).toString('base64'));
  assert.equal(k.private_key, key.private_key);
});

test('repairs real newlines inside private_key (sh echo damage)', () => {
  const broken = json.replace(/\\n/g, '\n');
  assert.throws(() => JSON.parse(broken));
  assert.equal(parseServiceAccountKey(broken).private_key, key.private_key);
});

test('repairs double-escaped newlines', () => {
  const doubled = JSON.stringify({ ...key, private_key: key.private_key.replace(/\n/g, '\\n') });
  assert.equal(parseServiceAccountKey(doubled).private_key, key.private_key);
});

test('strips surrounding quotes', () => {
  assert.equal(parseServiceAccountKey(`'${json}'`).client_email, key.client_email);
});

test('rejects non service-account keys with a helpful message', () => {
  assert.throws(() => parseServiceAccountKey('{"type":"authorized_user"}'), /service-account/);
  assert.throws(() => parseServiceAccountKey('not json at all!'), /neither JSON nor base64/);
});

test('loadCredentials: env precedence and missing creds', () => {
  assert.equal(loadCredentials({ env: { GOOGLE_CREDENTIALS_JSON: json } }).source, 'env GOOGLE_CREDENTIALS_JSON');
  assert.throws(() => loadCredentials({ env: {} }), /No Google service-account credentials/);
  assert.throws(() => loadCredentials({ env: { GOOGLE_APPLICATION_CREDENTIALS: '/nope.json' } }), /Cannot read key file/);
});
