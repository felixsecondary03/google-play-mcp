// @ts-check
import { z } from 'zod';

/** Error caused by bad tool input; reported verbatim. */
export class UserError extends Error {}


/** Shared zod fragments */
export const common = {
  packageName: z.string(),
  track: z
    .string()
    .describe('Track name: "internal", "alpha" (closed testing), "beta" (open testing), "production", or a custom closed-testing track name'),
  releaseNotes: z
    .array(z.object({ language: z.string().describe('BCP-47 language, e.g. en-US, de-DE'), text: z.string().max(500) }))
    .describe('"What\'s new" texts per language (max 500 chars each)'),
  editOptions: {
    validateOnly: z
      .boolean()
      .optional()
      .describe('Only let Google validate the change, then discard it (dry run). Default false.'),
    changesNotSentForReview: z
      .boolean()
      .optional()
      .describe(
        'Commit without sending the changes for review (required by Google for some apps, e.g. after a rejection or with managed publishing). Default false.'
      ),
  },
};
