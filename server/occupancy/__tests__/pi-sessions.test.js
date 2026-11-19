import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeOccupancyPayload } from '../policy.js';
import { projectOccupancy } from '../projector.js';

const NOW = 1_800_000_000_000;
const iso = ms => new Date(ms).toISOString();
const SPARK_URL = 'http://192.0.2.10:8000/v1';
const spark = { id: 'dgx-spark', name: 'DGX Spark', lanIp: '192.0.2.10', ssh: { host: 'spark-1.example' }, llmPorts: [8000] };
const endpoints = { 'dgx-spark': [{ port: 8000, modelId: 'example-model', models: ['example-model'] }] };
const helper = (over = {}) => ({ id: 'workstation', label: 'Workstation', url: 'http://127.0.0.1:8790/occupancy', enabled: true,
  harnesses: ['pi'], routes: [], ...over });

function piRow(over = {}) {
  const selection = { provider: 'local', model: 'example-model', baseUrl: SPARK_URL };
  return { harness: 'pi', schemaVersion: 1, publisherId: '00000000-0000-4000-8000-000000000001', sequence: 1,
    sessionId: 'session-A:00000000-0000-4000-8000-000000000001', title: 'A', cwd: '/fixture/shared',
    selection, requestDestination: { ...selection }, destinationEvidence: 'provider-matched',
    phase: 'receiving', requestOpen: true, updatedAt: iso(NOW), lastDeltaAt: NOW, lastSeenAt: NOW, ...over };
}
function cloudRow(over = {}) {
  const selection = { provider: 'openai', model: 'cloud-model', baseUrl: 'https://chatgpt.com/backend-api' };
  return piRow({ publisherId: '00000000-0000-4000-8000-000000000002',
    sessionId: 'session-B:00000000-0000-4000-8000-000000000002', title: 'B', selection,
    requestDestination: { ...selection }, ...over });
}
function envelope(rows, over = {}) {
  return { schemaVersion: 1, observedAt: NOW, adapters: { pi: { coverage: 'supported', stale: false, rows: rows.length, error: null } }, rows, ...over };
}
function project(rows, { now = NOW, helpers = [helper()], payload = envelope(rows), live = endpoints, sparks = [spark] } = {}) {
  const caches = new Map(helpers.map(h => [h.id, payload]));
  return projectOccupancy({ helpers, caches, sparks, now, maxAgeMs: 12 * 3600_000, endpoints: live });
}
const cards = out => Object.entries(out.bySpark).flatMap(([id, ports]) => Object.entries(ports).map(([port, rows]) => ({ id, port, rows })));

test('Pi rows are normalized with only the pinned schema; generic activity and origin are discarded', () => {
  const payload = normalizeOccupancyPayload(envelope([piRow({ activity: 'generating', activityProvenance: 'native',
    origin: { host: '192.0.2.10', port: 8000 }, originProvenance: 'native' })]));
  const row = payload.rows[0];
  assert.equal(row.harness, 'pi'); assert.equal(row.activity, 'unknown'); assert.equal(row.activityProvenance, 'none');
  assert.equal(row.origin, null); assert.equal(row.originProvenance, 'none');
  assert.equal(row.requestDestination.baseUrl, SPARK_URL); assert.equal(row.lastSeenAt, NOW);
});

test('invalid Pi rows are dropped, not repaired', () => {
  for (const bad of [
    piRow({ destinationEvidence: 'none' }),
    piRow({ requestDestination: { provider: 'local', model: 'other', baseUrl: SPARK_URL } }),
    piRow({ selection: { provider: 'local', model: 'example-model', baseUrl: 'https://user:pass@private.invalid/v1' } }),
    piRow({ lastSeenAt: NOW + 6000 }),
    piRow({ updatedAt: 'invalid' }),
    piRow({ sessionId: 'no-publisher-suffix' }),
    piRow({ payload: 'FIXTURE-CONTENT-CANARY' }),
  ]) {
    const payload = normalizeOccupancyPayload(envelope([bad]));
    assert.equal(payload.rows.length, 0, JSON.stringify(bad).slice(0, 80));
    assert.equal(JSON.stringify(payload).includes('CANARY'), false);
  }
});

test('the Spark session lands once on dgx-spark:8000 and the cloud session lands nowhere', () => {
  const out = project([piRow(), cloudRow()]);
  const all = cards(out);
  assert.equal(all.length, 1);
  assert.equal(all[0].id, 'dgx-spark'); assert.equal(all[0].port, '8000');
  assert.equal(all[0].rows.length, 1);
  assert.equal(all[0].rows[0].source, 'pi');
  assert.equal(all[0].rows[0].routingProvenance, 'pi-destination');
  assert.equal(all[0].rows[0].port, 8000);
  assert.equal(out.unmapped, 1);
});

test('a destination must match the card host, port and served model', () => {
  const wrongModel = piRow({ selection: { provider: 'local', model: 'other-model', baseUrl: SPARK_URL },
    requestDestination: { provider: 'local', model: 'other-model', baseUrl: SPARK_URL } });
  const wrongPort = piRow({ selection: { provider: 'local', model: 'example-model', baseUrl: 'http://192.0.2.10:8001/v1' },
    requestDestination: { provider: 'local', model: 'example-model', baseUrl: 'http://192.0.2.10:8001/v1' } });
  const wrongHost = piRow({ selection: { provider: 'local', model: 'example-model', baseUrl: 'http://192.0.2.99:8000/v1' },
    requestDestination: { provider: 'local', model: 'example-model', baseUrl: 'http://192.0.2.99:8000/v1' } });
  for (const row of [wrongModel, wrongPort, wrongHost]) assert.deepEqual(cards(project([row])), []);
  // A card that reports no model for the port cannot confirm the destination.
  assert.deepEqual(cards(project([piRow()], { live: { 'dgx-spark': [{ port: 8000, modelId: null, models: [] }] } })), []);
  // A multi-model router matches any model it serves.
  const multi = { 'dgx-spark': [{ port: 8000, modelId: 'first', models: ['first', 'example-model'] }] };
  assert.equal(cards(project([piRow()], { live: multi })).length, 1);
});

test('the destination must name the host the card actually probes', () => {
  const at = (baseUrl) => piRow({ selection: { provider: 'local', model: 'example-model', baseUrl },
    requestDestination: { provider: 'local', model: 'example-model', baseUrl } });
  // A pinned llmHost is the machine the probe talks to, not the SSH or LAN host.
  const pinned = { ...spark, llmHost: '192.0.2.20' };
  assert.equal(cards(project([at('http://192.0.2.20:8000/v1')], { sparks: [pinned] })).length, 1);
  assert.deepEqual(cards(project([at(SPARK_URL)], { sparks: [pinned] })), []);
  // A local Spark is probed on loopback, so loopback names are the same host.
  const local = { ...spark, isLocal: true };
  assert.equal(cards(project([at('http://127.0.0.1:8000/v1')], { sparks: [local] })).length, 1);
  assert.equal(cards(project([at('http://localhost:8000/v1')], { sparks: [local] })).length, 1);
  assert.deepEqual(cards(project([at(SPARK_URL)], { sparks: [local] })), []);
});

test('selection alone, an unproven destination and saved routes never place a Pi row', () => {
  const selectionOnly = piRow({ requestDestination: null, destinationEvidence: 'none', requestOpen: false, lastDeltaAt: null });
  const legacy = helper({ routes: [{ harness: 'pi', sparkId: 'dgx-spark', port: 8000 },
    { harness: 'pi', sparkId: 'dgx-spark', port: 8000, cwdPrefix: '/fixture' }] });
  assert.deepEqual(cards(project([selectionOnly])), []);
  assert.deepEqual(cards(project([cloudRow()], { helpers: [legacy] })), []);
  assert.deepEqual(cards(project([piRow()], { helpers: [helper({ enabled: false })] })), []);
});

test('generating needs an open matched request, a fresh row and a delta within ten seconds', () => {
  const badge = (row, now = NOW) => cards(project([row], { now }))[0]?.rows[0]?.badge;
  assert.equal(badge(piRow()), 'generating');
  assert.equal(badge(piRow(), NOW + 10_000), 'generating');
  assert.equal(badge(piRow(), NOW + 10_001), 'unknown');
  assert.equal(badge(piRow({ lastDeltaAt: null })), 'unknown');
  assert.equal(badge(piRow({ requestOpen: false })), 'unknown');
  assert.equal(badge(piRow({ phase: 'tools' })), 'unknown');
  assert.equal(badge(piRow({ phase: 'idle', requestOpen: false, lastDeltaAt: null })), 'unknown');
  assert.equal(badge(piRow({ destinationEvidence: 'none', requestDestination: null })), undefined);
});

test('heartbeat-only freshness cannot renew generation or fake last-used recency', () => {
  const heartbeatOnly = piRow({ lastDeltaAt: NOW - 20_000, updatedAt: iso(NOW - 20_000), lastSeenAt: NOW });
  const row = cards(project([heartbeatOnly]))[0].rows[0];
  assert.equal(row.badge, 'unknown');
  assert.equal(row.lastUsedAt, NOW - 20_000);
});

test('stale after 45s and omitted after 120s, even with a frozen cache and stale:false', () => {
  const frozen = envelope([piRow()]);
  const at = now => cards(project([piRow()], { now, payload: frozen }));
  assert.equal(at(NOW + 45_000)[0].rows[0].stale, false);
  assert.equal(at(NOW + 45_001)[0].rows[0].stale, true);
  assert.equal(at(NOW + 45_001)[0].rows[0].badge, 'unknown');
  assert.equal(at(NOW + 120_000).length, 1);
  assert.deepEqual(at(NOW + 120_001), []);
});

test('a stale helper cache suppresses Pi generation without hiding the row', () => {
  const payload = envelope([piRow()], { adapters: { pi: { coverage: 'partial', stale: true, rows: 1, error: null } } });
  const row = cards(project([piRow()], { payload }))[0].rows[0];
  assert.equal(row.badge, 'unknown'); assert.equal(row.stale, true);
});

test('the existing idle maxAge still bounds a retained Pi association', () => {
  const old = piRow({ requestOpen: false, lastDeltaAt: null, phase: 'idle', updatedAt: iso(NOW - 13 * 3600_000), lastSeenAt: NOW });
  assert.deepEqual(cards(project([old])), []);
});

test('other harnesses keep their existing routing and badge behaviour', () => {
  const hermes = { harness: 'hermes', sessionId: 'h1', title: 'H', cwd: '/x', updatedAt: iso(NOW),
    activity: 'generating', activityProvenance: 'native', origin: { host: '192.0.2.10', port: 8000 }, originProvenance: 'native' };
  const payload = { schemaVersion: 1, observedAt: NOW,
    adapters: { hermes: { coverage: 'supported', stale: false, rows: 1, error: null } }, rows: [hermes] };
  const out = projectOccupancy({ helpers: [helper({ harnesses: ['hermes'] })],
    caches: new Map([['workstation', payload]]), sparks: [spark], now: NOW, maxAgeMs: 12 * 3600_000 });
  const row = cards(out)[0].rows[0];
  assert.equal(row.source, 'hermes'); assert.equal(row.badge, 'generating');
  assert.equal(row.routingProvenance, 'native-endpoint');
});
