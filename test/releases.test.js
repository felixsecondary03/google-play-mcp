import test from 'node:test';
import assert from 'node:assert/strict';
import { applyRolloutAction, buildRelease, mergeReleaseIntoTrack } from '../src/releases.js';

const live = { name: '1.0', status: 'completed', versionCodes: ['10'] };
const staged = { name: '1.1', status: 'inProgress', versionCodes: ['11'], userFraction: 0.1 };
const draft = { name: '1.2', status: 'draft', versionCodes: ['12'] };

test('buildRelease validates staged rollouts', () => {
  assert.throws(() => buildRelease({ versionCodes: [11], status: 'inProgress' }), /userFraction/);
  assert.throws(() => buildRelease({ versionCodes: [11], status: 'inProgress', userFraction: 1 }), /userFraction/);
  assert.deepEqual(buildRelease({ versionCodes: [11], status: 'inProgress', userFraction: 0.2 }), {
    versionCodes: ['11'], status: 'inProgress', userFraction: 0.2,
  });
  assert.deepEqual(buildRelease({ versionCodes: [11], status: 'completed', userFraction: 0.2 }), { versionCodes: ['11'], status: 'completed' });
});

test('merge: completed replaces everything', () => {
  const r = { status: 'completed', versionCodes: ['13'] };
  assert.deepEqual(mergeReleaseIntoTrack([live, staged, draft], r), [r]);
});

test('merge: staged rollout keeps live release, replaces other staged/draft', () => {
  const r = { status: 'inProgress', versionCodes: ['13'], userFraction: 0.05 };
  assert.deepEqual(mergeReleaseIntoTrack([live, staged, draft], r), [live, r]);
});

test('merge: draft keeps live + staged, replaces draft', () => {
  const r = { status: 'draft', versionCodes: ['13'] };
  assert.deepEqual(mergeReleaseIntoTrack([live, staged, draft], r), [live, staged, r]);
});

test('rollout actions', () => {
  assert.deepEqual(applyRolloutAction([live, staged], { action: 'set_fraction', userFraction: 0.5 }).releases, [
    live, { ...staged, userFraction: 0.5 },
  ]);
  assert.equal(applyRolloutAction([live, staged], { action: 'halt' }).releases[1].status, 'halted');
  assert.equal(applyRolloutAction([live, { ...staged, status: 'halted' }], { action: 'resume' }).releases[1].status, 'inProgress');
  const done = applyRolloutAction([live, staged], { action: 'complete' }).releases;
  assert.deepEqual(done, [{ name: '1.1', status: 'completed', versionCodes: ['11'] }]);
  assert.throws(() => applyRolloutAction([live], { action: 'halt' }), /No staged rollout/);
  assert.throws(() => applyRolloutAction([live, staged], { action: 'set_fraction' }), /userFraction/);
});
