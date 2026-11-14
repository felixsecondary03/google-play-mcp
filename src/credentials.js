// @ts-check
import fs from 'node:fs';

/**
 * @typedef {object} ServiceAccountKey
 * @property {'service_account'} type
 * @property {string} client_email
 * @property {string} private_key
 * @property {string} [project_id]
 */

/**
 * Parse a service-account key given either as raw JSON or as base64-encoded JSON.
 * Repairs the most common breakage when keys are pasted into env vars:
 * private keys whose newlines got turned into literal "\n" or real newlines inside
 * the JSON string.
 *
 * @param {string} raw
 * @returns {ServiceAccountKey}
 */
export function parseServiceAccountKey(raw) {
  let text = raw.trim();

  // Strip accidental surrounding quotes, e.g. GOOGLE_CREDENTIALS_JSON='"{...}"'
  if (text.length > 1 && (text[0] === "'" || text[0] === '"') && text.at(-1) === text[0]) {
    text = text.slice(1, -1).trim();
  }

  // Base64-encoded JSON
  if (!text.startsWith('{')) {
    const decoded = Buffer.from(text, 'base64').toString('utf8').trim();
    if (!decoded.startsWith('{')) {
      throw new Error(
        'Credentials are neither JSON nor base64-encoded JSON. Paste the full content of the service-account key file.'
      );
    }
    text = decoded;
  }

  /** @type {any} */
  let key;
  try {
    key = JSON.parse(text);
  } catch {
    // Real newlines inside the private_key string (e.g. produced by `echo` in sh) make the JSON invalid.
    // Re-escape newlines that occur inside string literals and try again.
    try {
      key = JSON.parse(escapeNewlinesInsideStrings(text));
    } catch (err) {
      throw new Error(`Service-account key is not valid JSON: ${/** @type {Error} */ (err).message}`);
    }
  }

  if (key.type !== 'service_account') {
    throw new Error(
      `Expected a service-account key ("type": "service_account"), got "type": ${JSON.stringify(key.type)}. ` +
        'Create one in Google Cloud Console → IAM → Service Accounts → Keys → Add key → JSON.'
    );
  }
  for (const field of ['client_email', 'private_key']) {
    if (typeof key[field] !== 'string' || !key[field]) {
      throw new Error(`Service-account key is missing "${field}".`);
    }
  }

  // Literal backslash-n sequences left in the PEM (double-escaped keys)
  if (!key.private_key.includes('\n') && key.private_key.includes('\\n')) {
    key.private_key = key.private_key.replace(/\\n/g, '\n');
  }
  if (!key.private_key.includes('BEGIN PRIVATE KEY')) {
    throw new Error('Service-account "private_key" does not look like a PEM private key.');
  }
  return key;
}

/** @param {string} text */
function escapeNewlinesInsideStrings(text) {
  let out = '';
  let inString = false;
  let escaped = false;
  for (const ch of text) {
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      } else if (ch === '\n') {
        out += '\\n';
        continue;
      } else if (ch === '\r') {
        continue;
      }
    } else if (ch === '"') {
      inString = true;
    }
    out += ch;
  }
  return out;
}

/**
 * Resolve credentials from (in order):
 *   --key-file <path> CLI argument
 *   GOOGLE_CREDENTIALS_JSON / GOOGLE_PLAY_CREDENTIALS_JSON (raw JSON or base64)
 *   GOOGLE_APPLICATION_CREDENTIALS / GOOGLE_PLAY_KEY_FILE (path to key file)
 *
 * @param {{ keyFile?: string, env?: NodeJS.ProcessEnv }} [opts]
 * @returns {{ key: ServiceAccountKey, source: string }}
 */
export function loadCredentials(opts = {}) {
  const env = opts.env ?? process.env;

  if (opts.keyFile) {
    return { key: parseServiceAccountKey(readKeyFile(opts.keyFile)), source: `--key-file ${opts.keyFile}` };
  }
  for (const name of ['GOOGLE_CREDENTIALS_JSON', 'GOOGLE_PLAY_CREDENTIALS_JSON']) {
    const value = env[name];
    if (value && value.trim()) {
      return { key: parseServiceAccountKey(value), source: `env ${name}` };
    }
  }
  for (const name of ['GOOGLE_PLAY_KEY_FILE', 'GOOGLE_APPLICATION_CREDENTIALS']) {
    const value = env[name];
    if (value && value.trim()) {
      return { key: parseServiceAccountKey(readKeyFile(value.trim())), source: `env ${name}` };
    }
  }
  throw new Error(
    'No Google service-account credentials found. Set GOOGLE_CREDENTIALS_JSON to the content of your JSON key, ' +
      'or GOOGLE_APPLICATION_CREDENTIALS to the path of the key file, or pass --key-file <path>.'
  );
}

/** @param {string} path */
function readKeyFile(path) {
  try {
    return fs.readFileSync(path, 'utf8');
  } catch (err) {
    throw new Error(`Cannot read key file "${path}": ${/** @type {Error} */ (err).message}`);
  }
}
