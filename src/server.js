// @ts-check
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { describeGoogleError } from './google.js';
import { UserError } from './common.js';
import { registerAppTools } from './tools/apps.js';
import { registerReleaseTools } from './tools/releases.js';
import { registerListingTools } from './tools/listings.js';
import { registerReviewTools } from './tools/reviews.js';
import { registerMonetizationTools } from './tools/monetization.js';
import { registerVitalsTools } from './tools/vitals.js';

export const SERVER_NAME = 'google-play-console';
export const SERVER_VERSION = '2.0.0';

/**
 * @typedef {import('./google.js').GoogleClients} GoogleClients
 * @typedef {object} ServerConfig
 * @property {() => GoogleClients} getClients  lazily returns authenticated API clients (throws if no credentials)
 * @property {string} [defaultPackageName]     used when a tool call omits packageName
 * @property {string} [developerId]            Play Console developer account id (for list_users)
 * @property {boolean} [readOnly]              only register tools that do not change anything
 *
 * @typedef {object} ToolContext
 * @property {GoogleClients} clients
 * @property {(packageName?: string) => string} pkg
 * @property {ServerConfig} config
 *
 * @typedef {object} ToolSpec
 * @property {string} title
 * @property {string} description
 * @property {Record<string, z.ZodType>} [input]
 * @property {boolean} [readOnly]     tool does not modify anything
 * @property {boolean} [destructive]  tool may irreversibly change live data (releases, refunds, ...)
 *
 * @typedef {(name: string, spec: ToolSpec, handler: (args: any, ctx: ToolContext) => Promise<unknown>) => void} DefineTool
 */

/** @param {ServerConfig} config */
export function createServer(config) {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        'Tools for the Google Play Console (Google Play Developer API). ' +
        'Start with list_apps to find package names. Write tools (releases, listings, rollout, refunds) change the live app; ' +
        'confirm with the user before calling them, and prefer validateOnly: true first for release/listing changes.' +
        (config.defaultPackageName ? ` Default packageName: ${config.defaultPackageName}.` : ''),
    }
  );

  const packageNameSchema = config.defaultPackageName
    ? z.string().optional().describe(`Android package name, e.g. com.example.app (default: ${config.defaultPackageName})`)
    : z.string().describe('Android package name, e.g. com.example.app');

  /** @param {string} [packageName] */
  const pkg = (packageName) => {
    const value = packageName?.trim() || config.defaultPackageName;
    if (!value) throw new Error('packageName is required.');
    return value;
  };

  /** @type {DefineTool} */
  const defineTool = (name, spec, handler) => {
    if (config.readOnly && !spec.readOnly) return;
    const input = { ...(spec.input ?? {}) };
    if ('packageName' in input) input.packageName = packageNameSchema;
    server.registerTool(
      name,
      {
        title: spec.title,
        description: spec.description,
        inputSchema: input,
        annotations: {
          title: spec.title,
          readOnlyHint: !!spec.readOnly,
          destructiveHint: !spec.readOnly && !!spec.destructive,
          openWorldHint: true,
        },
      },
      async (/** @type {any} */ args) => {
        let clients;
        try {
          clients = config.getClients();
        } catch (err) {
          return errorResult(/** @type {Error} */ (err).message);
        }
        try {
          const result = await handler(args ?? {}, { clients, pkg, config });
          return {
            content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result, null, 2) }],
          };
        } catch (err) {
          if (err instanceof UserError) return errorResult(err.message);
          return errorResult(describeGoogleError(err, clients.clientEmail));
        }
      }
    );
  };

  registerAppTools(defineTool);
  registerReleaseTools(defineTool);
  registerListingTools(defineTool);
  registerReviewTools(defineTool);
  registerMonetizationTools(defineTool);
  registerVitalsTools(defineTool);

  return server;
}

/** @param {string} text */
function errorResult(text) {
  return { isError: true, content: [{ type: /** @type {const} */ ('text'), text }] };
}
