import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { registerPiObserver, createPiPublisherState } from '../../../agents/pi/index.js';
import { loadPi } from '../../../scripts/occupancy-helper/piAdapter.js';
import { normalizeOccupancyPayload } from '../policy.js';
import { projectOccupancy, llmEndpoints } from '../projector.js';
import { createOccupancyPoller } from '../poller.js';

// Real clock: the adapter compares file mtime against the projection clock.
const NOW = () => Date.now();
const SPARK_URL = 'http://192.0.2.10:8000/v1';
const spark = { id: 'dgx-spark', name: 'DGX Spark', lanIp: '192.0.2.10', ssh: { host: 'spark-1.example' }, llmPorts: [8000] };
const endpoints = { 'dgx-spark': [{ port: 8000, modelId: 'example-model', models: ['example-model'] }] };
const helper = { id: 'workstation', label: 'Workstation', url: 'http://127.0.0.1:8790/occupancy', enabled: true, harnesses: ['pi'], routes: [] };

function piApi() {
  const hooks = new Map();
  return { hooks, on: (name, fn) => hooks.set(name, fn) };
}
function context(sessionId, model) {
  return {
    cwd: '/fixture/shared',
    sessionManager: { getSessionId: () => sessionId, getSessionName: () => sessionId,
      getSessionFile: () => { throw Error('Forbidden history'); },
      getEntries: () => { throw Error('Forbidden content'); } },
    model: new Proxy(model, { get(o, k) { if (Object.hasOwn(o, k)) return o[k]; throw Error('Forbidden model field'); } }),
  };
}
const sparkModel = { provider: 'local', id: 'example-model', api: 'openai-completions', baseUrl: SPARK_URL };
const cloudModel = { provider: 'openai', id: 'cloud-model', api: 'openai-responses', baseUrl: 'https://chatgpt.com/backend-api' };

async function runSession(root, sessionId, model) {
  const api = piApi();
  const controller = registerPiObserver(api, { runtimeDir: root, shared: createPiPublisherState(), now: NOW,
    schedule: (fn, ms, repeat = false) => { if (!repeat) fn(); return () => {}; } });
  const ctx = context(sessionId, model);
  api.hooks.get('session_start')({}, ctx);
  api.hooks.get('before_provider_request')(new Proxy({}, { get() { throw Error('Forbidden payload'); } }), ctx);
  api.hooks.get('provider_stream_event')(new Proxy({ provider: model.provider, model: model.id, api: model.api }, {
    get(o, k) { if (Object.hasOwn(o, k)) return o[k]; throw Error('Forbidden stream data'); },
  }), ctx);
  api.hooks.get('message_update')({ assistantMessageEvent: { type: 'text_delta' } }, ctx);
  await controller.flush();
  return controller;
}

test('observer, files, helper, normalizer and projector: only the Spark session reaches the card', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sparkdash-pi-e2e-'));
  await fs.chmod(root, 0o700);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const a = await runSession(root, 'session-A', sparkModel);
  const b = await runSession(root, 'session-B', cloudModel);

  const adapter = await loadPi({ stateDir: path.join(root, 'pi-sparkdash-occupancy'), now: NOW });
  assert.equal(adapter.coverage, 'supported');
  assert.equal(adapter.rows.length, 2, 'the helper knows both sessions');

  const payload = normalizeOccupancyPayload({ schemaVersion: 1, observedAt: NOW(),
    adapters: { pi: { coverage: adapter.coverage, stale: adapter.stale, rows: adapter.rows.length, error: adapter.error } },
    rows: adapter.rows });
  assert.equal(payload.rows.length, 2);

  const out = projectOccupancy({ helpers: [helper], caches: new Map([['workstation', payload]]), sparks: [spark],
    now: NOW(), maxAgeMs: 12 * 3600_000, endpoints });
  const cards = Object.entries(out.bySpark).flatMap(([id, ports]) => Object.entries(ports).map(([port, rows]) => ({ id, port, rows })));
  assert.equal(cards.length, 1);
  assert.equal(cards[0].id, 'dgx-spark');
  assert.equal(cards[0].port, '8000');
  assert.equal(cards[0].rows.length, 1);
  assert.equal(cards[0].rows[0].source, 'pi');
  assert.equal(cards[0].rows[0].badge, 'generating');
  assert.equal(cards[0].rows[0].routingProvenance, 'pi-destination');
  assert.equal(out.unmapped, 1, 'the cloud session is known but unassigned');
  assert.equal(JSON.stringify(out).includes('session-B'), false);

  await a.stop();
  await b.stop();
});

test('a session that switches to the cloud leaves the Spark card', async t => {  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sparkdash-pi-switch-'));
  await fs.chmod(root, 0o700);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const api = piApi();
  const controller = registerPiObserver(api, { runtimeDir: root, shared: createPiPublisherState(), now: NOW,
    schedule: (fn, ms, repeat = false) => { if (!repeat) fn(); return () => {}; } });
  const sparkCtx = context('session-A', sparkModel);
  api.hooks.get('session_start')({}, sparkCtx);
  api.hooks.get('before_provider_request')({}, sparkCtx);
  api.hooks.get('provider_stream_event')({ provider: 'local', model: 'example-model', api: 'openai-completions' }, sparkCtx);
  await controller.flush();
  const dir = path.join(root, 'pi-sparkdash-occupancy');
  const before = await loadPi({ stateDir: dir, now: NOW });
  assert.equal(before.rows[0].destinationEvidence, 'provider-matched');

  const cloudCtx = context('session-A', cloudModel);
  api.hooks.get('before_provider_request')({}, cloudCtx);
  api.hooks.get('provider_stream_event')({ provider: 'openai', model: 'cloud-model', api: 'openai-responses' }, cloudCtx);
  await controller.flush();
  const after = await loadPi({ stateDir: dir, now: NOW });
  const payload = normalizeOccupancyPayload({ schemaVersion: 1, observedAt: NOW(),
    adapters: { pi: { coverage: after.coverage, stale: false, rows: after.rows.length, error: null } }, rows: after.rows });
  const out = projectOccupancy({ helpers: [helper], caches: new Map([['workstation', payload]]), sparks: [spark],
    now: NOW(), maxAgeMs: 12 * 3600_000, endpoints });
  assert.deepEqual(out.bySpark, {});
  await controller.stop();
});

test('the poller places a Pi session from the live LLM snapshot the dashboard already collects', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sparkdash-pi-poller-'));
  await fs.chmod(root, 0o700);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const a = await runSession(root, 'session-A', sparkModel);
  const b = await runSession(root, 'session-B', cloudModel);
  const adapter = await loadPi({ stateDir: path.join(root, 'pi-sparkdash-occupancy'), now: NOW });
  const payload = normalizeOccupancyPayload({ schemaVersion: 1, observedAt: NOW(),
    adapters: { pi: { coverage: adapter.coverage, stale: adapter.stale, rows: adapter.rows.length, error: adapter.error } },
    rows: adapter.rows });

  const helpersFile = path.join(root, 'occupancy-helpers.json');
  await fs.writeFile(helpersFile, JSON.stringify({ helpers: [helper] }));
  const previous = process.env.OCCUPANCY_HELPERS_JSON_PATH;
  process.env.OCCUPANCY_HELPERS_JSON_PATH = helpersFile;
  t.after(() => { if (previous === undefined) delete process.env.OCCUPANCY_HELPERS_JSON_PATH;
    else process.env.OCCUPANCY_HELPERS_JSON_PATH = previous; });

  const poller = createOccupancyPoller({ listSparks: () => [spark], fetchImpl: async () => payload, now: NOW });
  await poller.tick();

  // The shape SparkMonitor publishes: one entry per monitored LLM port.
  const snapshot = { id: 'dgx-spark', metrics: { llm: [{ port: 8000, available: true, modelId: 'example-model',
    models: ['example-model'] }] } };
  assert.deepEqual(llmEndpoints([snapshot]), endpoints);

  const out = poller.projection([snapshot]);
  const cards = Object.entries(out.bySpark).flatMap(([id, ports]) => Object.entries(ports).map(([port, rows]) => ({ id, port, rows })));
  assert.equal(cards.length, 1);
  assert.equal(cards[0].id, 'dgx-spark');
  assert.equal(cards[0].port, '8000');
  assert.equal(cards[0].rows.length, 1);
  assert.equal(cards[0].rows[0].source, 'pi');
  assert.equal(cards[0].rows[0].badge, 'generating');
  assert.equal(out.unmapped, 1);

  // With LLM monitoring off there is no endpoint to match, so nothing is placed.
  assert.deepEqual(poller.projection([]).bySpark, {});
  assert.deepEqual(poller.projection([{ id: 'dgx-spark', metrics: {} }]).bySpark, {});

  await a.stop();
  await b.stop();
});
