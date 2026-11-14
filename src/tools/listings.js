// @ts-check
import { z } from 'zod';
import { common, UserError } from '../common.js';
import { withEdit } from '../edits.js';
import { openMedia } from '../media.js';

const imageType = z.enum([
  'phoneScreenshots',
  'sevenInchScreenshots',
  'tenInchScreenshots',
  'tvScreenshots',
  'wearScreenshots',
  'icon',
  'featureGraphic',
  'tvBanner',
]);

/** @param {import('../server.js').DefineTool} defineTool */
export function registerListingTools(defineTool) {
  defineTool(
    'list_listings',
    {
      title: 'List store listings',
      description: 'Returns the store listing (title, short and full description, video) for every language.',
      input: { packageName: common.packageName },
      readOnly: true,
    },
    async ({ packageName }, { clients, pkg }) => {
      const p = pkg(packageName);
      const { result } = await withEdit(clients.publisher, p, async (editId) =>
        (await clients.publisher.edits.listings.list({ packageName: p, editId })).data.listings ?? []
      );
      return result;
    }
  );

  defineTool(
    'get_listing',
    {
      title: 'Get store listing',
      description: 'Returns the store listing for one language.',
      input: { packageName: common.packageName, language: z.string().describe('BCP-47, e.g. en-US, de-DE') },
      readOnly: true,
    },
    async ({ packageName, language }, { clients, pkg }) => {
      const p = pkg(packageName);
      const { result } = await withEdit(clients.publisher, p, async (editId) =>
        (await clients.publisher.edits.listings.get({ packageName: p, editId, language })).data
      );
      return result;
    }
  );

  defineTool(
    'update_listing',
    {
      title: 'Update store listing',
      description:
        'Creates or updates the store listing for a language. Only the given fields are changed. ' +
        'Limits: title 30, shortDescription 80, fullDescription 4000 characters.',
      input: {
        packageName: common.packageName,
        language: z.string().describe('BCP-47, e.g. en-US, de-DE'),
        title: z.string().max(30).optional(),
        shortDescription: z.string().max(80).optional(),
        fullDescription: z.string().max(4000).optional(),
        video: z.string().optional().describe('YouTube URL, empty string removes it'),
        ...common.editOptions,
      },
    },
    async ({ packageName, language, validateOnly, changesNotSentForReview, ...fields }, { clients, pkg }) => {
      const p = pkg(packageName);
      const patch = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
      if (!Object.keys(patch).length) throw new UserError('Nothing to update: pass title, shortDescription, fullDescription or video.');
      const publisher = clients.publisher;
      const out = await withEdit(
        publisher,
        p,
        async (editId) => {
          /** @type {any} */
          let existing = {};
          try {
            existing = (await publisher.edits.listings.get({ packageName: p, editId, language })).data;
          } catch (err) {
            if (/** @type {any} */ (err)?.response?.status !== 404) throw err;
          }
          const requestBody = { ...existing, ...patch, language };
          return (await publisher.edits.listings.update({ packageName: p, editId, language, requestBody })).data;
        },
        { commit: true, validateOnly, changesNotSentForReview }
      );
      return { committed: out.committed, validated: out.validated, listing: out.result };
    }
  );

  defineTool(
    'list_images',
    {
      title: 'List store images',
      description: 'Lists screenshots / icon / feature graphic of a store listing language, with download URLs.',
      input: { packageName: common.packageName, language: z.string(), imageType },
      readOnly: true,
    },
    async ({ packageName, language, imageType }, { clients, pkg }) => {
      const p = pkg(packageName);
      const { result } = await withEdit(clients.publisher, p, async (editId) =>
        (await clients.publisher.edits.images.list({ packageName: p, editId, language, imageType })).data.images ?? []
      );
      return result;
    }
  );

  defineTool(
    'upload_image',
    {
      title: 'Upload store image',
      description:
        'Uploads a PNG/JPEG screenshot or graphic to a store listing language. Use replaceExisting to delete all existing images of that type first.',
      input: {
        packageName: common.packageName,
        language: z.string(),
        imageType,
        image: z.string().describe('https:// URL or local path of the PNG/JPEG file'),
        replaceExisting: z.boolean().optional(),
        ...common.editOptions,
      },
    },
    async ({ packageName, language, imageType, image, replaceExisting, validateOnly, changesNotSentForReview }, { clients, pkg }) => {
      const p = pkg(packageName);
      const publisher = clients.publisher;
      const out = await withEdit(
        publisher,
        p,
        async (editId) => {
          if (replaceExisting) await publisher.edits.images.deleteall({ packageName: p, editId, language, imageType });
          const media = await openMedia(image);
          const mimeType = /\.jpe?g($|\?)/i.test(image) ? 'image/jpeg' : 'image/png';
          return (
            await publisher.edits.images.upload({ packageName: p, editId, language, imageType, media: { mimeType, body: media.body } })
          ).data.image;
        },
        { commit: true, validateOnly, changesNotSentForReview }
      );
      return { committed: out.committed, validated: out.validated, image: out.result };
    }
  );
}
