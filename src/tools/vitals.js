// @ts-check
import { z } from 'zod';
import { common, UserError } from '../common.js';

/**
 * metric key → [API resource on reporting.vitals, metric-set resource name, default metrics, default dimensions]
 * @type {Record<string, { resource: string, set: string, metrics: string[], dimensions?: string[] }>}
 */
export const METRIC_SETS = {
  crashRate: { resource: 'crashrate', set: 'crashRateMetricSet', metrics: ['crashRate', 'userPerceivedCrashRate', 'distinctUsers'] },
  anrRate: { resource: 'anrrate', set: 'anrRateMetricSet', metrics: ['anrRate', 'userPerceivedAnrRate', 'distinctUsers'] },
  slowStartRate: {
    resource: 'slowstartrate',
    set: 'slowStartRateMetricSet',
    metrics: ['slowStartRate', 'distinctUsers'],
    dimensions: ['startType'],
  },
  slowRenderingRate: {
    resource: 'slowrenderingrate',
    set: 'slowRenderingRateMetricSet',
    metrics: ['slowRenderingRate20Fps', 'slowRenderingRate30Fps', 'distinctUsers'],
  },
  excessiveWakeupRate: { resource: 'excessivewakeuprate', set: 'excessiveWakeupRateMetricSet', metrics: ['excessiveWakeupRate', 'distinctUsers'] },
  stuckBackgroundWakelockRate: {
    resource: 'stuckbackgroundwakelockrate',
    set: 'stuckBackgroundWakelockRateMetricSet',
    metrics: ['stuckBgWakelockRate', 'distinctUsers'],
  },
  lmkRate: { resource: 'lmkrate', set: 'lmkRateMetricSet', metrics: ['userPerceivedLmkRate', 'distinctUsers'] },
};

/**
 * @param {{ year?: number|null, month?: number|null, day?: number|null }} d
 * @param {number} deltaDays
 */
export function shiftDate(d, deltaDays) {
  const t = new Date(Date.UTC(d.year ?? 1970, (d.month ?? 1) - 1, d.day ?? 1));
  t.setUTCDate(t.getUTCDate() + deltaDays);
  return { year: t.getUTCFullYear(), month: t.getUTCMonth() + 1, day: t.getUTCDate() };
}

/** @param {any} row */
export function formatMetricRow(row) {
  const st = row.startTime ?? {};
  /** @type {Record<string, unknown>} */
  const out = {
    date: `${st.year}-${String(st.month).padStart(2, '0')}-${String(st.day).padStart(2, '0')}` + (st.hours != null ? ` ${String(st.hours).padStart(2, '0')}:00` : ''),
  };
  for (const d of row.dimensions ?? []) {
    out[d.dimension] = d.stringValue ?? d.int64Value ?? d.valueLabel ?? null;
  }
  for (const m of row.metrics ?? []) {
    const v = m.decimalValue?.value;
    out[m.metric] = v === undefined ? null : Number(v);
  }
  return out;
}

/** @param {import('../server.js').DefineTool} defineTool */
export function registerVitalsTools(defineTool) {
  defineTool(
    'get_vitals',
    {
      title: 'Get Android vitals',
      description:
        'Daily Android vitals from the Play Developer Reporting API: crash rate, ANR rate, slow start/rendering, wakeups, wakelocks, LMK. ' +
        'Rates are fractions (0.0123 = 1.23 %). Google\'s bad-behaviour thresholds: user-perceived crash rate 1.09 %, user-perceived ANR rate 0.47 %. ' +
        'Optionally slice by dimensions such as versionCode, apiLevel, deviceModel, countryCode.',
      input: {
        packageName: common.packageName,
        metricSet: z.enum(/** @type {[string, ...string[]]} */ (Object.keys(METRIC_SETS))).optional().describe('Default crashRate'),
        days: z.number().int().min(1).max(365).optional().describe('Number of most recent days with data (default 28)'),
        dimensions: z.array(z.string()).optional().describe('e.g. ["versionCode"]'),
        metrics: z.array(z.string()).optional().describe('Override metrics (default: main rate, user-perceived rate, distinctUsers)'),
        filter: z.string().optional().describe('AIP-160 filter on dimensions, e.g. versionCode = 123 OR countryCode = "DE"'),
        maxRows: z.number().int().min(1).max(5000).optional().describe('Default 500'),
      },
      readOnly: true,
    },
    async (args, { clients, pkg }) => {
      const p = pkg(args.packageName);
      const def = METRIC_SETS[args.metricSet ?? 'crashRate'];
      /** @type {any} */
      const api = /** @type {any} */ (clients.reporting.vitals)[def.resource];
      const name = `apps/${p}/${def.set}`;

      const meta = (await api.get({ name })).data;
      const fresh = (meta.freshnessInfo?.freshnesses ?? []).find((/** @type {any} */ f) => f.aggregationPeriod === 'DAILY');
      if (!fresh?.latestEndTime) throw new UserError(`No DAILY data available yet for ${def.set}.`);
      const end = fresh.latestEndTime;
      const days = args.days ?? 28;
      const start = shiftDate(end, -days);
      const tz = { id: 'America/Los_Angeles' };

      const rows = [];
      /** @type {string | undefined} */
      let pageToken;
      const maxRows = args.maxRows ?? 500;
      do {
        const res = await api.query({
          name,
          requestBody: {
            timelineSpec: {
              aggregationPeriod: 'DAILY',
              startTime: { ...start, timeZone: tz },
              endTime: { year: end.year, month: end.month, day: end.day, timeZone: tz },
            },
            metrics: args.metrics ?? def.metrics,
            dimensions: args.dimensions ?? def.dimensions,
            filter: args.filter,
            pageSize: Math.min(maxRows, 1000),
            pageToken,
          },
        });
        rows.push(...(res.data.rows ?? []).map(formatMetricRow));
        pageToken = res.data.nextPageToken ?? undefined;
      } while (pageToken && rows.length < maxRows);

      rows.sort((a, b) => String(b.date).localeCompare(String(a.date)));
      return {
        metricSet: def.set,
        timezone: tz.id,
        latestDataDate: `${end.year}-${end.month}-${end.day}`,
        rowCount: rows.length,
        rows: rows.slice(0, maxRows),
      };
    }
  );

  defineTool(
    'search_error_issues',
    {
      title: 'Search crash & ANR issues',
      description:
        'Lists grouped crash / ANR issues (like Play Console "Crashes and ANRs") with cause, location, report count, affected users and app versions.',
      input: {
        packageName: common.packageName,
        filter: z.string().optional().describe('e.g. errorIssueType = CRASH, errorIssueType = ANR, versionCode = 123'),
        orderBy: z.string().optional().describe('e.g. "errorReportCount desc" (default) or "distinctUsers desc"'),
        pageSize: z.number().int().min(1).max(1000).optional().describe('Default 25'),
      },
      readOnly: true,
    },
    async ({ packageName, filter, orderBy, pageSize = 25 }, { clients, pkg }) => {
      const res = await clients.reporting.vitals.errors.issues.search({
        parent: `apps/${pkg(packageName)}`,
        filter,
        orderBy: orderBy ?? 'errorReportCount desc',
        pageSize,
      });
      return { issues: res.data.errorIssues ?? [], nextPageToken: res.data.nextPageToken ?? undefined };
    }
  );

  defineTool(
    'search_error_reports',
    {
      title: 'Search crash & ANR reports',
      description: 'Returns individual error reports incl. stack traces, e.g. for one issue (filter: errorIssueId = <id from search_error_issues>).',
      input: {
        packageName: common.packageName,
        filter: z.string().optional().describe('e.g. errorIssueId = 1234567890'),
        pageSize: z.number().int().min(1).max(100).optional().describe('Default 5'),
      },
      readOnly: true,
    },
    async ({ packageName, filter, pageSize = 5 }, { clients, pkg }) => {
      const res = await clients.reporting.vitals.errors.reports.search({ parent: `apps/${pkg(packageName)}`, filter, pageSize });
      return { reports: res.data.errorReports ?? [], nextPageToken: res.data.nextPageToken ?? undefined };
    }
  );

  defineTool(
    'list_vitals_anomalies',
    {
      title: 'List vitals anomalies',
      description: 'Lists anomalies Google detected in the app\'s vitals metrics (sudden spikes in crash/ANR rates etc.).',
      input: { packageName: common.packageName, pageSize: z.number().int().min(1).max(100).optional() },
      readOnly: true,
    },
    async ({ packageName, pageSize = 50 }, { clients, pkg }) => {
      const res = await clients.reporting.anomalies.list({ parent: `apps/${pkg(packageName)}`, pageSize });
      return { anomalies: res.data.anomalies ?? [] };
    }
  );
}
