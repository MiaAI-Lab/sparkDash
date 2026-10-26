import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { appendObservation, observation } from '../journal.js';
import { createOverseerRuntime, readJournal } from '../runtime.js';

async function fixture(t, { enabled = true, sparkId = 'gb10-a', read } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'spark-overseer-'));
  const journal = path.join(dir, 'events.ndjson'), config = path.join(dir, 'config.json');
  await fs.writeFile(config, JSON.stringify({ sources: [{ sparkId, journal }] }));
  const runtime = createOverseerRuntime({ enabled, configFile: config, getUnits: () => [{ id: 'gb10-a', name: 'GB10 A' }], read, pollMs: 10 });
  t.after(async () => { await runtime.close(); await fs.rm(dir, { recursive: true, force: true }); });
  return { dir, journal, config, runtime };
}
test('disabled makes no source reads and reports unavailable totals', async t => {
  let calls = 0;
  const { runtime } = await fixture(t, { enabled: false, read: async () => { calls++; throw Error('unexpected'); } });
  await runtime.start(); await runtime.poll();
  assert.equal(calls, 0); assert.equal(runtime.snapshot().summary, null); assert.equal(runtime.snapshot().state, 'disabled');
});
test('continuous polling detects a real append without any HTTP request and deduplicates repeated tails', async t => {
  const { journal, runtime } = await fixture(t);
  appendObservation(journal, observation(['curl', '-d', 'synthetic', 'https://sink.example/'], { model: 'fixture-model' }));
  await runtime.start();
  assert.equal(runtime.snapshot().summary.flagged, 1);
  appendObservation(journal, observation('nft flush ruleset', { model: 'fixture-model' }));
  for (let i = 0; i < 100 && runtime.snapshot().events.length < 2; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(runtime.snapshot().summary.actions, 2);
  assert.equal(runtime.snapshot().summary.high, 1);
  await runtime.poll();
  assert.equal(runtime.snapshot().events.length, 2);
});
test('missing, malformed, partial-line and rotated journals remain explicit', async t => {
  const { journal, runtime } = await fixture(t);
  await runtime.start(); assert.equal(runtime.snapshot().state, 'partial'); assert.equal(runtime.snapshot().summary, null);
  const event = observation('read docs');
  await fs.writeFile(journal, 'not-json\n' + JSON.stringify(event));
  await runtime.poll(); assert.equal(runtime.snapshot().sources[0].invalid, 1); assert.equal(runtime.snapshot().sources[0].pending, true);
  await fs.appendFile(journal, '\n'); await runtime.poll(); assert.equal(runtime.snapshot().events.length, 1);
  await fs.rename(journal, journal + '.rotated');
  appendObservation(journal, observation('read more docs'));
  await runtime.poll(); assert.equal(runtime.snapshot().events.length, 2); assert.equal(runtime.snapshot().state, 'observing');
});
test('unconfigured unit source is not attributed to a different Spark', async t => {
  const { journal, runtime } = await fixture(t, { sparkId: 'not-in-registry' });
  appendObservation(journal, observation('ordinary action'));
  await runtime.start(); assert.equal(runtime.snapshot().sources[0].state, 'unknown-unit'); assert.equal(runtime.snapshot().events.length, 0);
});
test('read bounds, symlink refusal and capacity warnings', async t => {
  const { dir, journal, runtime } = await fixture(t);
  await fs.writeFile(journal, ('x'.repeat(1000) + '\n').repeat(5000), { mode: 0o600 });
  const result = await readJournal(journal);
  assert.ok(result.lines.length <= 1000); assert.equal(result.truncated, true); assert.equal(result.full, true);
  assert.throws(() => appendObservation(journal, observation('full')), /capacity/);
  const link = path.join(dir, 'link'); await fs.symlink(journal, link);
  await assert.rejects(readJournal(link)); assert.throws(() => appendObservation(link, observation('link')));
  await runtime.start(); assert.equal(runtime.snapshot().state, 'partial');
});
test('process start/finish updates one event and timestamps expire at 24h', async t => {
  const { journal, runtime } = await fixture(t);
  const event = observation('ordinary action');
  appendObservation(journal, event); appendObservation(journal, { ...event, finished: true, exitCode: 3 });
  appendObservation(journal, { ...observation('expired'), timestamp: Date.now() - 90000000 });
  await runtime.start(); assert.equal(runtime.snapshot().events.length, 1); assert.equal(runtime.snapshot().events[0].exitCode, 3);
});
