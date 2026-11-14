// @ts-check

/**
 * @typedef {import('./google.js').Publisher} Publisher
 * @typedef {{ commit?: boolean, validateOnly?: boolean, changesNotSentForReview?: boolean }} EditOptions
 */

/**
 * Run `fn` inside a Play Console edit (transaction).
 * - read-only usage (commit: false): edit is always deleted afterwards
 * - validateOnly: changes are validated by Google, then discarded
 * - otherwise the edit is committed; on any error it is deleted
 *
 * @template T
 * @param {Publisher} publisher
 * @param {string} packageName
 * @param {(editId: string) => Promise<T>} fn
 * @param {EditOptions} [opts]
 * @returns {Promise<{ result: T, editId: string, committed: boolean, validated: boolean }>}
 */
export async function withEdit(publisher, packageName, fn, opts = {}) {
  const { commit = false, validateOnly = false, changesNotSentForReview = false } = opts;
  const insert = await publisher.edits.insert({ packageName, requestBody: {} });
  const editId = insert.data.id;
  if (!editId) throw new Error('Google Play did not return an edit id.');

  let finished = false;
  try {
    const result = await fn(editId);
    if (!commit) {
      return { result, editId, committed: false, validated: false };
    }
    if (validateOnly) {
      await publisher.edits.validate({ packageName, editId });
      return { result, editId, committed: false, validated: true };
    }
    await publisher.edits.commit({ packageName, editId, changesNotSentForReview: changesNotSentForReview || undefined });
    finished = true;
    return { result, editId, committed: true, validated: true };
  } finally {
    if (!finished) {
      await publisher.edits.delete({ packageName, editId }).catch(() => {});
    }
  }
}
