import test from 'node:test';
import assert from 'node:assert/strict';
import { connect, fakeApi, text } from './helpers.js';

const PKG = 'com.example.app';

function setup(handlers, extra = {}) {
  const { api, calls } = fakeApi({
    'edits.insert': () => ({ id: 'edit-1' }),
    'edits.delete': () => ({}),
    'edits.commit': () => ({ id: 'edit-1' }),
    'edits.validate': () => ({ id: 'edit-1' }),
    ...handlers,
  });
  const clients = { publisher: api, reporting: api, clientEmail: 'bot@demo.iam.gserviceaccount.com' };
  return { calls, config: { getClients: () => clients, ...extra } };
}

const methods = (calls) => calls.map((c) => c.method);

test('lists all tools; read-only mode hides write tools', async () => {
  const { config } = setup({});
  const all = (await (await connect(config)).listTools()).tools;
  const names = all.map((t) => t.name);
  for (const n of ['list_apps', 'list_tracks', 'upload_bundle', 'create_release', 'promote_release', 'update_rollout',
    'list_reviews', 'reply_to_review', 'update_listing', 'get_vitals', 'search_error_issues', 'refund_order']) {
    assert.ok(names.includes(n), `missing ${n}`);
  }
  assert.equal(all.find((t) => t.name === 'refund_order').annotations.destructiveHint, true);
  assert.equal(all.find((t) => t.name === 'list_tracks').annotations.readOnlyHint, true);

  const ro = (await (await connect({ ...config, readOnly: true })).listTools()).tools;
  assert.ok(ro.every((t) => t.annotations.readOnlyHint));
  assert.ok(!ro.some((t) => t.name === 'create_release'));
  console.log(`  ${all.length} tools (${ro.length} read-only)`);
});

test('list_tracks opens and deletes a read-only edit', async () => {
  const { config, calls } = setup({
    'edits.tracks.list': () => ({ tracks: [{ track: 'production', releases: [{ status: 'completed', versionCodes: ['10'] }] }] }),
  });
  const client = await connect(config);
  const res = await client.callTool({ name: 'list_tracks', arguments: { packageName: PKG } });
  assert.ok(!res.isError, text(res));
  assert.deepEqual(JSON.parse(text(res)), [{ track: 'production', releases: [{ status: 'completed', versionCodes: ['10'] }] }]);
  assert.deepEqual(methods(calls), ['edits.insert', 'edits.tracks.list', 'edits.delete']);
});

test('create_release staged rollout keeps live release and commits', async () => {
  const { config, calls } = setup({
    'edits.tracks.get': () => ({ track: 'production', releases: [{ status: 'completed', versionCodes: ['10'] }] }),
    'edits.tracks.update': (p) => p.requestBody,
  });
  const client = await connect(config);
  const res = await client.callTool({
    name: 'create_release',
    arguments: {
      packageName: PKG, track: 'production', versionCodes: [11], status: 'inProgress', userFraction: 0.1,
      releaseNotes: [{ language: 'de-DE', text: 'Fehlerbehebungen' }],
    },
  });
  assert.ok(!res.isError, text(res));
  const update = calls.find((c) => c.method === 'edits.tracks.update');
  assert.deepEqual(update.params.requestBody.releases, [
    { status: 'completed', versionCodes: ['10'] },
    { status: 'inProgress', versionCodes: ['11'], userFraction: 0.1, releaseNotes: [{ language: 'de-DE', text: 'Fehlerbehebungen' }] },
  ]);
  assert.deepEqual(methods(calls), ['edits.insert', 'edits.tracks.get', 'edits.tracks.update', 'edits.commit']);
  assert.equal(JSON.parse(text(res)).committed, true);
});

test('validateOnly validates and discards the edit', async () => {
  const { config, calls } = setup({
    'edits.tracks.get': () => ({ releases: [] }),
    'edits.tracks.update': (p) => p.requestBody,
  });
  const client = await connect(config);
  const res = await client.callTool({
    name: 'create_release',
    arguments: { packageName: PKG, track: 'internal', versionCodes: ['5'], status: 'completed', validateOnly: true },
  });
  assert.ok(!res.isError, text(res));
  assert.deepEqual(methods(calls), ['edits.insert', 'edits.tracks.get', 'edits.tracks.update', 'edits.validate', 'edits.delete']);
  assert.deepEqual(JSON.parse(text(res)).committed, false);
});

test('API errors delete the edit and return actionable hints', async () => {
  const { config, calls } = setup({
    'edits.tracks.get': () => {
      const err = new Error('The caller does not have permission');
      err.response = { status: 403, data: { error: { message: 'The caller does not have permission' } } };
      throw err;
    },
  });
  const client = await connect(config);
  const res = await client.callTool({ name: 'update_rollout', arguments: { packageName: PKG, action: 'halt' } });
  assert.equal(res.isError, true);
  assert.match(text(res), /403/);
  assert.match(text(res), /Users and permissions/);
  assert.deepEqual(methods(calls), ['edits.insert', 'edits.tracks.get', 'edits.delete']);
});

test('update_rollout without staged release explains the track state', async () => {
  const { config } = setup({ 'edits.tracks.get': () => ({ releases: [{ status: 'completed', versionCodes: ['10'] }] }) });
  const res = await (await connect(config)).callTool({ name: 'update_rollout', arguments: { packageName: PKG, action: 'complete' } });
  assert.equal(res.isError, true);
  assert.match(text(res), /No staged rollout/);
});

test('promote_release copies the completed release from source to target', async () => {
  const { config, calls } = setup({
    'edits.tracks.get': (p) =>
      p.track === 'internal'
        ? { releases: [{ name: '2.0', status: 'completed', versionCodes: ['20'], releaseNotes: [{ language: 'en-US', text: 'New' }] }] }
        : { releases: [{ status: 'completed', versionCodes: ['10'] }] },
    'edits.tracks.update': (p) => p.requestBody,
  });
  const res = await (await connect(config)).callTool({
    name: 'promote_release',
    arguments: { packageName: PKG, fromTrack: 'internal', toTrack: 'production', status: 'inProgress', userFraction: 0.2 },
  });
  assert.ok(!res.isError, text(res));
  const update = calls.find((c) => c.method === 'edits.tracks.update');
  assert.equal(update.params.track, 'production');
  assert.deepEqual(update.params.requestBody.releases[1], {
    name: '2.0', status: 'inProgress', versionCodes: ['20'], userFraction: 0.2, releaseNotes: [{ language: 'en-US', text: 'New' }],
  });
});

test('list_reviews formats and filters', async () => {
  const review = (id, stars, reply) => ({
    reviewId: id, authorName: 'A',
    comments: [
      { userComment: { text: '\tgood', starRating: stars, lastModified: { seconds: '1700000000' }, reviewerLanguage: 'de' } },
      ...(reply ? [{ developerComment: { text: 'thx', lastModified: { seconds: '1700000100' } } }] : []),
    ],
  });
  const { config } = setup({ 'reviews.list': () => ({ reviews: [review('a', 1), review('b', 5), review('c', 2, true)] }) });
  const res = await (await connect(config)).callTool({
    name: 'list_reviews', arguments: { packageName: PKG, maxStars: 2, unansweredOnly: true },
  });
  const out = JSON.parse(text(res));
  assert.equal(out.count, 1);
  assert.equal(out.reviews[0].reviewId, 'a');
  assert.equal(out.reviews[0].text, 'good');
  assert.equal(out.reviews[0].lastModified, '2023-11-14T22:13:20.000Z');
});

test('default package name is used when omitted', async () => {
  const { config, calls } = setup({ 'reviews.reply': () => ({ result: { replyText: 'Danke!' } }) }, { defaultPackageName: PKG });
  const res = await (await connect(config)).callTool({ name: 'reply_to_review', arguments: { reviewId: 'r1', replyText: 'Danke!' } });
  assert.ok(!res.isError, text(res));
  assert.equal(calls[0].params.packageName, PKG);
});

test('get_vitals queries the latest available window', async () => {
  const { config, calls } = setup({
    'vitals.crashrate.get': () => ({
      freshnessInfo: { freshnesses: [{ aggregationPeriod: 'DAILY', latestEndTime: { year: 2026, month: 3, day: 2, timeZone: { id: 'America/Los_Angeles' } } }] },
    }),
    'vitals.crashrate.query': () => ({
      rows: [{ startTime: { year: 2026, month: 3, day: 1 }, metrics: [{ metric: 'crashRate', decimalValue: { value: '0.0123' } }] }],
    }),
  });
  const res = await (await connect(config)).callTool({ name: 'get_vitals', arguments: { packageName: PKG, days: 7 } });
  assert.ok(!res.isError, text(res));
  const q = calls.find((c) => c.method === 'vitals.crashrate.query').params;
  assert.equal(q.name, `apps/${PKG}/crashRateMetricSet`);
  assert.deepEqual(q.requestBody.timelineSpec.startTime, { year: 2026, month: 2, day: 23, timeZone: { id: 'America/Los_Angeles' } });
  assert.deepEqual(JSON.parse(text(res)).rows, [{ date: '2026-03-01', crashRate: 0.0123 }]);
});

test('missing credentials produce a clear tool error', async () => {
  const client = await connect({ getClients: () => { throw new Error('No Google service-account credentials found.'); } });
  const res = await client.callTool({ name: 'list_apps', arguments: {} });
  assert.equal(res.isError, true);
  assert.match(text(res), /No Google service-account credentials/);
});
