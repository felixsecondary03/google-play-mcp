// @ts-check
import { z } from 'zod';
import { common } from '../common.js';

/** @param {import('@googleapis/androidpublisher').androidpublisher_v3.Schema$Review} r */
export function formatReview(r) {
  const user = r.comments?.find((c) => c.userComment)?.userComment;
  const dev = r.comments?.find((c) => c.developerComment)?.developerComment;
  const ts = (/** @type {any} */ t) => (t?.seconds ? new Date(Number(t.seconds) * 1000).toISOString() : undefined);
  return {
    reviewId: r.reviewId,
    author: r.authorName || undefined,
    stars: user?.starRating,
    text: user?.text?.trim(),
    originalText: user?.originalText?.trim() || undefined,
    language: user?.reviewerLanguage,
    lastModified: ts(user?.lastModified),
    appVersion: user?.appVersionName ?? undefined,
    appVersionCode: user?.appVersionCode ?? undefined,
    androidOsVersion: user?.androidOsVersion ?? undefined,
    device: user?.deviceMetadata?.productName ?? user?.device ?? undefined,
    thumbsUp: user?.thumbsUpCount || undefined,
    developerReply: dev ? { text: dev.text, lastModified: ts(dev.lastModified) } : undefined,
  };
}

/** @param {import('../server.js').DefineTool} defineTool */
export function registerReviewTools(defineTool) {
  defineTool(
    'list_reviews',
    {
      title: 'List reviews',
      description:
        'Lists user reviews with text (Google only returns reviews created or edited in the last 7 days). ' +
        'Filter by stars or unanswered reviews.',
      input: {
        packageName: common.packageName,
        maxResults: z.number().int().min(1).max(500).optional().describe('Default 50'),
        translationLanguage: z.string().optional().describe('Translate review texts to this language, e.g. de or en'),
        maxStars: z.number().int().min(1).max(5).optional().describe('Only reviews with at most this many stars'),
        minStars: z.number().int().min(1).max(5).optional(),
        unansweredOnly: z.boolean().optional().describe('Only reviews without developer reply'),
      },
      readOnly: true,
    },
    async (args, { clients, pkg }) => {
      const p = pkg(args.packageName);
      const max = args.maxResults ?? 50;
      const reviews = [];
      /** @type {string | undefined} */
      let token;
      do {
        const res = await clients.publisher.reviews.list({
          packageName: p,
          maxResults: 100,
          token,
          translationLanguage: args.translationLanguage,
        });
        for (const r of res.data.reviews ?? []) {
          const f = formatReview(r);
          if (args.maxStars && (f.stars ?? 0) > args.maxStars) continue;
          if (args.minStars && (f.stars ?? 0) < args.minStars) continue;
          if (args.unansweredOnly && f.developerReply) continue;
          reviews.push(f);
        }
        token = res.data.tokenPagination?.nextPageToken ?? undefined;
      } while (token && reviews.length < max);
      return { count: Math.min(reviews.length, max), reviews: reviews.slice(0, max) };
    }
  );

  defineTool(
    'get_review',
    {
      title: 'Get review',
      description: 'Returns a single review by id.',
      input: {
        packageName: common.packageName,
        reviewId: z.string(),
        translationLanguage: z.string().optional(),
      },
      readOnly: true,
    },
    async ({ packageName, reviewId, translationLanguage }, { clients, pkg }) => {
      const res = await clients.publisher.reviews.get({ packageName: pkg(packageName), reviewId, translationLanguage });
      return formatReview(res.data);
    }
  );

  defineTool(
    'reply_to_review',
    {
      title: 'Reply to review',
      description: 'Publicly replies to a review (or replaces the existing reply). Max 350 characters. Visible on Google Play.',
      input: {
        packageName: common.packageName,
        reviewId: z.string(),
        replyText: z.string().min(1).max(350),
      },
    },
    async ({ packageName, reviewId, replyText }, { clients, pkg }) => {
      const res = await clients.publisher.reviews.reply({ packageName: pkg(packageName), reviewId, requestBody: { replyText } });
      return { replied: true, reviewId, result: res.data.result };
    }
  );
}
