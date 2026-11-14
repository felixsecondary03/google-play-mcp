// @ts-check
import { z } from 'zod';
import { common } from '../common.js';

/** @param {string | undefined} iso */
function toMillis(iso) {
  if (!iso) return undefined;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new Error(`Invalid date: ${iso}`);
  return String(ms);
}

/** @param {import('../server.js').DefineTool} defineTool */
export function registerMonetizationTools(defineTool) {
  defineTool(
    'list_in_app_products',
    {
      title: 'List in-app products',
      description: 'Lists one-time in-app products (managed products) with their purchase options and prices.',
      input: {
        packageName: common.packageName,
        pageSize: z.number().int().min(1).max(1000).optional(),
      },
      readOnly: true,
    },
    async ({ packageName, pageSize = 100 }, { clients, pkg }) => {
      const p = pkg(packageName);
      try {
        const products = [];
        /** @type {string | undefined} */
        let pageToken;
        do {
          const res = await clients.publisher.monetization.onetimeproducts.list({ packageName: p, pageSize: 100, pageToken });
          products.push(...(res.data.oneTimeProducts ?? []));
          pageToken = res.data.nextPageToken ?? undefined;
        } while (pageToken && products.length < pageSize);
        return { count: products.length, products: products.slice(0, pageSize) };
      } catch (err) {
        // Fallback to the legacy in-app products API
        const status = /** @type {any} */ (err)?.response?.status;
        if (status !== 404 && status !== 400) throw err;
        const res = await clients.publisher.inappproducts.list({ packageName: p, maxResults: pageSize });
        return { legacyApi: true, count: res.data.inappproduct?.length ?? 0, products: res.data.inappproduct ?? [] };
      }
    }
  );

  defineTool(
    'list_subscriptions',
    {
      title: 'List subscriptions',
      description: 'Lists subscription products with base plans, offers and regional prices.',
      input: {
        packageName: common.packageName,
        showArchived: z.boolean().optional(),
        pageSize: z.number().int().min(1).max(1000).optional(),
      },
      readOnly: true,
    },
    async ({ packageName, showArchived, pageSize = 100 }, { clients, pkg }) => {
      const p = pkg(packageName);
      const subscriptions = [];
      /** @type {string | undefined} */
      let pageToken;
      do {
        const res = await clients.publisher.monetization.subscriptions.list({ packageName: p, showArchived, pageSize: 100, pageToken });
        subscriptions.push(...(res.data.subscriptions ?? []));
        pageToken = res.data.nextPageToken ?? undefined;
      } while (pageToken && subscriptions.length < pageSize);
      return { count: subscriptions.length, subscriptions: subscriptions.slice(0, pageSize) };
    }
  );

  defineTool(
    'get_subscription_purchase',
    {
      title: 'Get subscription purchase',
      description:
        'Looks up a subscription purchase by purchase token: state (active, canceled, in grace period, on hold, expired), expiry, auto-renew, order id, offer.',
      input: { packageName: common.packageName, purchaseToken: z.string() },
      readOnly: true,
    },
    async ({ packageName, purchaseToken }, { clients, pkg }) =>
      (await clients.publisher.purchases.subscriptionsv2.get({ packageName: pkg(packageName), token: purchaseToken })).data
  );

  defineTool(
    'get_product_purchase',
    {
      title: 'Get one-time product purchase',
      description: 'Looks up a one-time (in-app product) purchase by purchase token: state, acknowledgement, consumption, order id.',
      input: { packageName: common.packageName, purchaseToken: z.string() },
      readOnly: true,
    },
    async ({ packageName, purchaseToken }, { clients, pkg }) =>
      (await clients.publisher.purchases.productsv2.getproductpurchasev2({ packageName: pkg(packageName), token: purchaseToken })).data
  );

  defineTool(
    'list_voided_purchases',
    {
      title: 'List voided purchases',
      description: 'Lists purchases that were refunded, charged back or canceled (last 30 days by default).',
      input: {
        packageName: common.packageName,
        startTime: z.string().optional().describe('ISO date/time, e.g. 2026-01-01 (max 30 days back)'),
        endTime: z.string().optional().describe('ISO date/time'),
        includeSubscriptions: z.boolean().optional().describe('Also include voided subscription purchases (default true)'),
        maxResults: z.number().int().min(1).max(1000).optional(),
      },
      readOnly: true,
    },
    async (args, { clients, pkg }) => {
      const res = await clients.publisher.purchases.voidedpurchases.list({
        packageName: pkg(args.packageName),
        startTime: toMillis(args.startTime),
        endTime: toMillis(args.endTime),
        type: args.includeSubscriptions === false ? 0 : 1,
        maxResults: args.maxResults ?? 100,
      });
      const items = (res.data.voidedPurchases ?? []).map((v) => ({
        ...v,
        purchaseTime: v.purchaseTimeMillis ? new Date(Number(v.purchaseTimeMillis)).toISOString() : undefined,
        voidedTime: v.voidedTimeMillis ? new Date(Number(v.voidedTimeMillis)).toISOString() : undefined,
      }));
      return { count: items.length, voidedPurchases: items, nextPageToken: res.data.tokenPagination?.nextPageToken ?? undefined };
    }
  );

  defineTool(
    'get_order',
    {
      title: 'Get order',
      description: 'Returns details of an order (GPA.xxxx-xxxx-xxxx-xxxxx): state, line items, prices, taxes, buyer country.',
      input: { packageName: common.packageName, orderId: z.string() },
      readOnly: true,
    },
    async ({ packageName, orderId }, { clients, pkg }) =>
      (await clients.publisher.orders.get({ packageName: pkg(packageName), orderId })).data
  );

  defineTool(
    'refund_order',
    {
      title: 'Refund order',
      description:
        'Fully refunds an order. IRREVERSIBLE. With revoke: true the user also immediately loses access to the purchased item / subscription.',
      input: {
        packageName: common.packageName,
        orderId: z.string(),
        revoke: z.boolean().optional().describe('Also revoke the entitlement (default false)'),
      },
      destructive: true,
    },
    async ({ packageName, orderId, revoke }, { clients, pkg }) => {
      await clients.publisher.orders.refund({ packageName: pkg(packageName), orderId, revoke: revoke ?? false });
      return { refunded: true, orderId, revoked: !!revoke };
    }
  );
}
