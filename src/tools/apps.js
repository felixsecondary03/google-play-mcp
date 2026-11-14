// @ts-check
import { z } from 'zod';
import { common, UserError } from '../common.js';
import { withEdit } from '../edits.js';

/** @param {import('../server.js').DefineTool} defineTool */
export function registerAppTools(defineTool) {
  defineTool(
    'list_apps',
    {
      title: 'List apps',
      description:
        'Lists all apps the service account can access in Play Console (package name + display name). ' +
        'Uses the Play Developer Reporting API, which must be enabled in the Google Cloud project.',
      input: { pageSize: z.number().int().min(1).max(1000).optional().describe('Max apps to return (default 200)') },
      readOnly: true,
    },
    async ({ pageSize = 200 }, { clients }) => {
      const apps = [];
      /** @type {string | undefined} */
      let pageToken;
      do {
        const res = await clients.reporting.apps.search({ pageSize: Math.min(pageSize, 1000), pageToken });
        apps.push(...(res.data.apps ?? []).map((a) => ({ packageName: a.packageName, displayName: a.displayName })));
        pageToken = res.data.nextPageToken ?? undefined;
      } while (pageToken && apps.length < pageSize);
      return { count: apps.length, apps };
    }
  );

  defineTool(
    'get_app_details',
    {
      title: 'Get app details',
      description: 'Returns the app\'s store contact details and default language (contactEmail, contactPhone, contactWebsite, defaultLanguage).',
      input: { packageName: common.packageName },
      readOnly: true,
    },
    async ({ packageName }, { clients, pkg }) => {
      const p = pkg(packageName);
      const { result } = await withEdit(clients.publisher, p, async (editId) =>
        (await clients.publisher.edits.details.get({ packageName: p, editId })).data
      );
      return { packageName: p, ...result };
    }
  );

  defineTool(
    'update_app_details',
    {
      title: 'Update app details',
      description: 'Updates store contact details and/or default language. Only the given fields are changed. Goes live after commit.',
      input: {
        packageName: common.packageName,
        contactEmail: z.string().email().optional(),
        contactPhone: z.string().optional(),
        contactWebsite: z.string().url().optional(),
        defaultLanguage: z.string().optional().describe('BCP-47, e.g. en-US'),
        ...common.editOptions,
      },
    },
    async ({ packageName, validateOnly, changesNotSentForReview, ...fields }, { clients, pkg }) => {
      const p = pkg(packageName);
      const patch = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
      if (!Object.keys(patch).length) throw new UserError('Nothing to update: pass at least one field.');
      const out = await withEdit(
        clients.publisher,
        p,
        async (editId) => (await clients.publisher.edits.details.patch({ packageName: p, editId, requestBody: patch })).data,
        { commit: true, validateOnly, changesNotSentForReview }
      );
      return { committed: out.committed, validated: out.validated, details: out.result };
    }
  );

  defineTool(
    'list_users',
    {
      title: 'List Play Console users',
      description:
        'Lists users of the Play Console developer account with their permissions. Needs the developer account ID ' +
        '(the number in the Play Console URL: play.google.com/console/u/0/developers/<developerId>/...), or set PLAY_DEVELOPER_ID.',
      input: { developerId: z.string().optional().describe('Developer account ID') },
      readOnly: true,
    },
    async ({ developerId }, { clients, config }) => {
      const id = developerId || config.developerId;
      if (!id) throw new UserError('developerId is required (or set the PLAY_DEVELOPER_ID environment variable).');
      const users = [];
      /** @type {string | undefined} */
      let pageToken;
      do {
        const res = await clients.publisher.users.list({ parent: `developers/${id}`, pageSize: 200, pageToken });
        users.push(...(res.data.users ?? []));
        pageToken = res.data.nextPageToken ?? undefined;
      } while (pageToken);
      return { count: users.length, users };
    }
  );
}
