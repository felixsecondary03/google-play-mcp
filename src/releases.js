// @ts-check

/**
 * @typedef {import('@googleapis/androidpublisher').androidpublisher_v3.Schema$TrackRelease} TrackRelease
 * @typedef {'draft' | 'inProgress' | 'halted' | 'completed'} ReleaseStatus
 */

/**
 * Build a release object from tool input.
 * @param {{ versionCodes: (string|number)[], status: ReleaseStatus, userFraction?: number, name?: string,
 *           releaseNotes?: { language: string, text: string }[], inAppUpdatePriority?: number }} input
 * @returns {TrackRelease}
 */
export function buildRelease(input) {
  const { versionCodes, status, userFraction, name, releaseNotes, inAppUpdatePriority } = input;
  if (!versionCodes.length) throw new Error('At least one versionCode is required.');
  if (status === 'inProgress' || status === 'halted') {
    if (userFraction === undefined) {
      throw new Error(`status "${status}" (staged rollout) requires userFraction, e.g. 0.1 for 10%.`);
    }
  }
  if (userFraction !== undefined && !(userFraction > 0 && userFraction < 1)) {
    throw new Error('userFraction must be > 0 and < 1 (e.g. 0.05 = 5%). Use status "completed" for 100%.');
  }
  /** @type {TrackRelease} */
  const release = { versionCodes: versionCodes.map(String), status };
  if (name) release.name = name;
  if ((status === 'inProgress' || status === 'halted') && userFraction !== undefined) release.userFraction = userFraction;
  if (releaseNotes?.length) release.releaseNotes = releaseNotes;
  if (inAppUpdatePriority !== undefined) release.inAppUpdatePriority = inAppUpdatePriority;
  return release;
}

/**
 * Merge a new release into the existing releases of a track, mirroring Play Console behaviour:
 *  - completed  → becomes the only release (replaces previous completed / staged / draft releases)
 *  - inProgress/halted (staged rollout) → keeps the current completed release (served to everybody else),
 *    replaces any other staged rollout or draft
 *  - draft      → keeps live releases, replaces existing drafts
 *
 * @param {TrackRelease[]} existing
 * @param {TrackRelease} release
 * @returns {TrackRelease[]}
 */
export function mergeReleaseIntoTrack(existing, release) {
  switch (release.status) {
    case 'completed':
      return [release];
    case 'inProgress':
    case 'halted':
      return [...existing.filter((r) => r.status === 'completed'), release];
    case 'draft':
      return [...existing.filter((r) => r.status !== 'draft'), release];
    default:
      throw new Error(`Unsupported release status "${release.status}".`);
  }
}

/**
 * Pick a release on a track.
 * @param {TrackRelease[]} releases
 * @param {{ versionCode?: string|number, releaseName?: string, statuses?: string[] }} [selector]
 */
export function findRelease(releases, selector = {}) {
  const { versionCode, releaseName, statuses } = selector;
  let candidates = releases;
  if (versionCode !== undefined) {
    candidates = candidates.filter((r) => (r.versionCodes ?? []).includes(String(versionCode)));
  }
  if (releaseName) candidates = candidates.filter((r) => r.name === releaseName);
  if (statuses) {
    for (const s of statuses) {
      const hit = candidates.find((r) => r.status === s);
      if (hit) return hit;
    }
    return undefined;
  }
  return candidates[0];
}

/**
 * Apply a rollout action to the staged release on a track.
 * @param {TrackRelease[]} releases
 * @param {{ action: 'set_fraction' | 'halt' | 'resume' | 'complete', userFraction?: number, versionCode?: string|number }} input
 * @returns {{ releases: TrackRelease[], target: TrackRelease }}
 */
export function applyRolloutAction(releases, input) {
  const { action, userFraction, versionCode } = input;
  const staged = findRelease(releases, { versionCode, statuses: ['inProgress', 'halted'] });
  if (!staged) {
    throw new Error(
      'No staged rollout (status inProgress or halted) found on this track' +
        (versionCode !== undefined ? ` for versionCode ${versionCode}` : '') +
        '. Current releases: ' +
        JSON.stringify(releases.map((r) => ({ name: r.name, status: r.status, versionCodes: r.versionCodes, userFraction: r.userFraction })))
    );
  }
  /** @type {TrackRelease} */
  const updated = { ...staged };
  switch (action) {
    case 'set_fraction':
      if (userFraction === undefined || !(userFraction > 0 && userFraction < 1)) {
        throw new Error('set_fraction requires userFraction > 0 and < 1. Use action "complete" for 100%.');
      }
      updated.status = 'inProgress';
      updated.userFraction = userFraction;
      break;
    case 'halt':
      updated.status = 'halted';
      break;
    case 'resume':
      updated.status = 'inProgress';
      if (userFraction !== undefined) updated.userFraction = userFraction;
      break;
    case 'complete':
      updated.status = 'completed';
      delete updated.userFraction;
      return { releases: [updated], target: updated };
    default:
      throw new Error(`Unknown rollout action "${action}".`);
  }
  return { releases: releases.map((r) => (r === staged ? updated : r)), target: updated };
}
