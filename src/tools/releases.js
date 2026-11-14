// @ts-check
import { z } from 'zod';
import { common, UserError } from '../common.js';
import { withEdit } from '../edits.js';
import { openMedia } from '../media.js';
import { applyRolloutAction, buildRelease, findRelease, mergeReleaseIntoTrack } from '../releases.js';

const statusSchema = z
  .enum(['draft', 'inProgress', 'halted', 'completed'])
  .describe('draft = save without publishing; inProgress = staged rollout (needs userFraction); completed = roll out to 100%');

const releaseInput = {
  status: statusSchema,
  userFraction: z.number().gt(0).lt(1).optional().describe('Staged rollout fraction for status inProgress, e.g. 0.1 = 10%'),
  releaseName: z.string().optional().describe('Release name shown in Play Console (default: version name)'),
  releaseNotes: common.releaseNotes.optional(),
  inAppUpdatePriority: z.number().int().min(0).max(5).optional(),
};

/** @param {import('@googleapis/androidpublisher').androidpublisher_v3.Schema$TrackRelease} r */
function summarizeRelease(r) {
  return {
    name: r.name,
    status: r.status,
    versionCodes: r.versionCodes,
    userFraction: r.userFraction ?? undefined,
    releaseNotes: r.releaseNotes ?? undefined,
    inAppUpdatePriority: r.inAppUpdatePriority ?? undefined,
    countryTargeting: r.countryTargeting ?? undefined,
  };
}

/** @param {import('../server.js').DefineTool} defineTool */
export function registerReleaseTools(defineTool) {
  defineTool(
    'list_tracks',
    {
      title: 'List tracks and releases',
      description:
        'Lists all tracks (internal, alpha, beta, production, custom) with their current releases: status, version codes, rollout fraction and release notes.',
      input: { packageName: common.packageName },
      readOnly: true,
    },
    async ({ packageName }, { clients, pkg }) => {
      const p = pkg(packageName);
      const { result } = await withEdit(clients.publisher, p, async (editId) =>
        (await clients.publisher.edits.tracks.list({ packageName: p, editId })).data.tracks ?? []
      );
      return result.map((t) => ({ track: t.track, releases: (t.releases ?? []).map(summarizeRelease) }));
    }
  );

  defineTool(
    'get_track',
    {
      title: 'Get track',
      description: 'Returns the releases currently on one track.',
      input: { packageName: common.packageName, track: common.track },
      readOnly: true,
    },
    async ({ packageName, track }, { clients, pkg }) => {
      const p = pkg(packageName);
      const { result } = await withEdit(clients.publisher, p, async (editId) =>
        (await clients.publisher.edits.tracks.get({ packageName: p, editId, track })).data
      );
      return { track: result.track, releases: (result.releases ?? []).map(summarizeRelease) };
    }
  );

  defineTool(
    'get_release_status',
    {
      title: 'Get release review status',
      description:
        'Lists releases of a track with their lifecycle state as shown in Play Console ' +
        '(e.g. draft, in review, approved/ready to publish, rejected, available/released).',
      input: { packageName: common.packageName, track: common.track },
      readOnly: true,
    },
    async ({ packageName, track }, { clients, pkg }) => {
      const p = pkg(packageName);
      const res = await clients.publisher.applications.tracks.releases.list({ parent: `applications/${p}/tracks/${track}` });
      return res.data.releases ?? [];
    }
  );

  defineTool(
    'list_bundles',
    {
      title: 'List uploaded bundles',
      description: 'Lists all Android App Bundles (AAB) and APKs uploaded for the app with their version codes.',
      input: { packageName: common.packageName },
      readOnly: true,
    },
    async ({ packageName }, { clients, pkg }) => {
      const p = pkg(packageName);
      const { result } = await withEdit(clients.publisher, p, async (editId) => {
        const [bundles, apks] = await Promise.all([
          clients.publisher.edits.bundles.list({ packageName: p, editId }),
          clients.publisher.edits.apks.list({ packageName: p, editId }),
        ]);
        return {
          bundles: (bundles.data.bundles ?? []).map((b) => ({ versionCode: b.versionCode, sha256: b.sha256 })),
          apks: (apks.data.apks ?? []).map((a) => ({ versionCode: a.versionCode, sha256: a.binary?.sha256 })),
        };
      });
      const latest = Math.max(0, ...result.bundles.map((b) => b.versionCode ?? 0), ...result.apks.map((a) => a.versionCode ?? 0));
      return { highestVersionCode: latest || null, ...result };
    }
  );

  defineTool(
    'upload_bundle',
    {
      title: 'Upload app bundle (AAB)',
      description:
        'Uploads an .aab file and (optionally) assigns it to a track as a new release, in a single committed edit. ' +
        'Source can be an https:// URL or a file path on the machine running this MCP server. ' +
        'Optionally uploads the R8/ProGuard mapping.txt for deobfuscated crash reports.',
      input: {
        packageName: common.packageName,
        bundle: z.string().describe('https:// URL or local path of the .aab file'),
        track: common.track.optional().describe('If set, create a release with the uploaded bundle on this track'),
        ...releaseInput,
        status: statusSchema.optional().describe('Release status when track is set (default "draft")'),
        mappingFile: z.string().optional().describe('https:// URL or local path of mapping.txt (optional)'),
        ackBundleInstallationWarning: z.boolean().optional().describe('Acknowledge warnings for bundles > 150 MB'),
        ...common.editOptions,
      },
      destructive: true,
    },
    async (args, { clients, pkg }) => {
      const p = pkg(args.packageName);
      const publisher = clients.publisher;
      const out = await withEdit(
        publisher,
        p,
        async (editId) => {
          const media = await openMedia(args.bundle);
          const uploaded = await publisher.edits.bundles.upload(
            {
              packageName: p,
              editId,
              ackBundleInstallationWarning: args.ackBundleInstallationWarning,
              media: { mimeType: 'application/octet-stream', body: media.body },
            },
            { timeout: 15 * 60_000, retryConfig: { retry: 0 } }
          );
          const versionCode = uploaded.data.versionCode;
          if (!versionCode) throw new Error('Upload succeeded but Google returned no versionCode.');

          let mapping;
          if (args.mappingFile) {
            const m = await openMedia(args.mappingFile);
            await publisher.edits.deobfuscationfiles.upload({
              packageName: p,
              editId,
              apkVersionCode: versionCode,
              deobfuscationFileType: 'proguard',
              media: { mimeType: 'application/octet-stream', body: m.body },
            });
            mapping = 'uploaded';
          }

          let track;
          if (args.track) {
            const release = buildRelease({
              versionCodes: [versionCode],
              status: args.status ?? 'draft',
              userFraction: args.userFraction,
              name: args.releaseName,
              releaseNotes: args.releaseNotes,
              inAppUpdatePriority: args.inAppUpdatePriority,
            });
            const current = (await publisher.edits.tracks.get({ packageName: p, editId, track: args.track })).data;
            const releases = mergeReleaseIntoTrack(current.releases ?? [], release);
            const updated = await publisher.edits.tracks.update({
              packageName: p,
              editId,
              track: args.track,
              requestBody: { track: args.track, releases },
            });
            track = { track: updated.data.track, releases: (updated.data.releases ?? []).map(summarizeRelease) };
          }
          return { versionCode, sha256: uploaded.data.sha256, mapping, track };
        },
        { commit: true, validateOnly: args.validateOnly, changesNotSentForReview: args.changesNotSentForReview }
      );
      return { committed: out.committed, validated: out.validated, ...out.result };
    }
  );

  defineTool(
    'create_release',
    {
      title: 'Create release on track',
      description:
        'Creates or replaces the release on a track using version codes that were already uploaded. ' +
        'completed = full rollout (replaces the current release); inProgress = staged rollout to userFraction ' +
        '(the current completed release keeps serving the remaining users); draft = saved but not published.',
      input: {
        packageName: common.packageName,
        track: common.track,
        versionCodes: z.array(z.union([z.string(), z.number().int()])).min(1),
        ...releaseInput,
        ...common.editOptions,
      },
      destructive: true,
    },
    async (args, { clients, pkg }) => {
      const p = pkg(args.packageName);
      const release = buildRelease({
        versionCodes: args.versionCodes,
        status: args.status,
        userFraction: args.userFraction,
        name: args.releaseName,
        releaseNotes: args.releaseNotes,
        inAppUpdatePriority: args.inAppUpdatePriority,
      });
      const out = await withEdit(
        clients.publisher,
        p,
        async (editId) => {
          const current = (await clients.publisher.edits.tracks.get({ packageName: p, editId, track: args.track })).data;
          const releases = mergeReleaseIntoTrack(current.releases ?? [], release);
          return (
            await clients.publisher.edits.tracks.update({
              packageName: p,
              editId,
              track: args.track,
              requestBody: { track: args.track, releases },
            })
          ).data;
        },
        { commit: true, validateOnly: args.validateOnly, changesNotSentForReview: args.changesNotSentForReview }
      );
      return {
        committed: out.committed,
        validated: out.validated,
        track: out.result.track,
        releases: (out.result.releases ?? []).map(summarizeRelease),
      };
    }
  );

  defineTool(
    'promote_release',
    {
      title: 'Promote release to another track',
      description:
        'Copies a release (version codes, name, release notes) from one track to another, e.g. internal → production. ' +
        'By default picks the completed release of the source track (or the staged one if there is none).',
      input: {
        packageName: common.packageName,
        fromTrack: common.track.describe('Source track'),
        toTrack: common.track.describe('Target track'),
        versionCode: z.union([z.string(), z.number().int()]).optional().describe('Pick the source release containing this version code'),
        ...releaseInput,
        releaseNotes: common.releaseNotes.optional().describe('Override release notes (default: copy from source)'),
        ...common.editOptions,
      },
      destructive: true,
    },
    async (args, { clients, pkg }) => {
      const p = pkg(args.packageName);
      const publisher = clients.publisher;
      const out = await withEdit(
        publisher,
        p,
        async (editId) => {
          const source = (await publisher.edits.tracks.get({ packageName: p, editId, track: args.fromTrack })).data;
          const sourceRelease = findRelease(source.releases ?? [], {
            versionCode: args.versionCode,
            statuses: ['completed', 'inProgress', 'halted', 'draft'],
          });
          if (!sourceRelease?.versionCodes?.length) {
            throw new UserError(
              `No matching release with version codes found on track "${args.fromTrack}"` +
                (args.versionCode !== undefined ? ` for versionCode ${args.versionCode}` : '') +
                '.'
            );
          }
          const release = buildRelease({
            versionCodes: sourceRelease.versionCodes,
            status: args.status,
            userFraction: args.userFraction,
            name: args.releaseName ?? sourceRelease.name ?? undefined,
            releaseNotes: args.releaseNotes ?? /** @type {any} */ (sourceRelease.releaseNotes ?? undefined),
            inAppUpdatePriority: args.inAppUpdatePriority ?? sourceRelease.inAppUpdatePriority ?? undefined,
          });
          const target = (await publisher.edits.tracks.get({ packageName: p, editId, track: args.toTrack })).data;
          const releases = mergeReleaseIntoTrack(target.releases ?? [], release);
          const updated = await publisher.edits.tracks.update({
            packageName: p,
            editId,
            track: args.toTrack,
            requestBody: { track: args.toTrack, releases },
          });
          return { promoted: summarizeRelease(sourceRelease), target: updated.data };
        },
        { commit: true, validateOnly: args.validateOnly, changesNotSentForReview: args.changesNotSentForReview }
      );
      return {
        committed: out.committed,
        validated: out.validated,
        promoted: out.result.promoted,
        toTrack: out.result.target.track,
        releases: (out.result.target.releases ?? []).map(summarizeRelease),
      };
    }
  );

  defineTool(
    'update_rollout',
    {
      title: 'Update staged rollout',
      description:
        'Changes the staged rollout on a track: set_fraction (e.g. 0.2 → 20%), halt, resume, or complete (100%).',
      input: {
        packageName: common.packageName,
        track: common.track.optional().describe('Track (default "production")'),
        action: z.enum(['set_fraction', 'halt', 'resume', 'complete']),
        userFraction: z.number().gt(0).lt(1).optional().describe('New rollout fraction for set_fraction / resume'),
        versionCode: z.union([z.string(), z.number().int()]).optional().describe('Select the staged release by version code'),
        ...common.editOptions,
      },
      destructive: true,
    },
    async (args, { clients, pkg }) => {
      const p = pkg(args.packageName);
      const track = args.track ?? 'production';
      const out = await withEdit(
        clients.publisher,
        p,
        async (editId) => {
          const current = (await clients.publisher.edits.tracks.get({ packageName: p, editId, track })).data;
          let applied;
          try {
            applied = applyRolloutAction(current.releases ?? [], args);
          } catch (err) {
            throw new UserError(/** @type {Error} */ (err).message);
          }
          return (
            await clients.publisher.edits.tracks.update({
              packageName: p,
              editId,
              track,
              requestBody: { track, releases: applied.releases },
            })
          ).data;
        },
        { commit: true, validateOnly: args.validateOnly, changesNotSentForReview: args.changesNotSentForReview }
      );
      return {
        committed: out.committed,
        validated: out.validated,
        track,
        releases: (out.result.releases ?? []).map(summarizeRelease),
      };
    }
  );

  defineTool(
    'get_testers',
    {
      title: 'Get testers of a track',
      description: 'Returns the Google Groups configured as testers for a testing track.',
      input: { packageName: common.packageName, track: common.track },
      readOnly: true,
    },
    async ({ packageName, track }, { clients, pkg }) => {
      const p = pkg(packageName);
      const { result } = await withEdit(clients.publisher, p, async (editId) =>
        (await clients.publisher.edits.testers.get({ packageName: p, editId, track })).data
      );
      return { track, googleGroups: result.googleGroups ?? [] };
    }
  );

  defineTool(
    'update_testers',
    {
      title: 'Set testers of a track',
      description: 'Replaces the Google Groups that are testers of a testing track.',
      input: {
        packageName: common.packageName,
        track: common.track,
        googleGroups: z.array(z.string().email()).describe('Google Group email addresses'),
        ...common.editOptions,
      },
    },
    async ({ packageName, track, googleGroups, validateOnly, changesNotSentForReview }, { clients, pkg }) => {
      const p = pkg(packageName);
      const out = await withEdit(
        clients.publisher,
        p,
        async (editId) =>
          (await clients.publisher.edits.testers.update({ packageName: p, editId, track, requestBody: { googleGroups } })).data,
        { commit: true, validateOnly, changesNotSentForReview }
      );
      return { committed: out.committed, validated: out.validated, track, googleGroups: out.result.googleGroups ?? [] };
    }
  );
}
