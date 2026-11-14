// @ts-check
import fs from 'node:fs';
import { Readable } from 'node:stream';
import { UserError } from './common.js';

/**
 * Open a file for upload from a local path (on the machine running this server) or an http(s) URL.
 * @param {string} source
 * @returns {Promise<{ body: Readable, size?: number }>}
 */
export async function openMedia(source) {
  if (/^https?:\/\//i.test(source)) {
    const res = await fetch(source, { redirect: 'follow' });
    if (!res.ok || !res.body) {
      throw new UserError(`Download of ${source} failed: HTTP ${res.status} ${res.statusText}`);
    }
    const length = Number(res.headers.get('content-length')) || undefined;
    return { body: Readable.fromWeb(/** @type {any} */ (res.body)), size: length };
  }
  const path = source.startsWith('file://') ? new URL(source).pathname : source;
  let stat;
  try {
    stat = fs.statSync(path);
  } catch {
    throw new UserError(
      `File not found on the MCP server machine: ${path}. When the server runs remotely, pass an https:// URL instead.`
    );
  }
  if (!stat.isFile()) throw new UserError(`${path} is not a file.`);
  return { body: fs.createReadStream(path), size: stat.size };
}
