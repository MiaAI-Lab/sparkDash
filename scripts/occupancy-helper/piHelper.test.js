import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createOccupancyHelper, isMainModule } from './index.js';
import { HARNESSES, harnessById } from '../../server/occupancy/catalog.js';

const NOW = 1_800_000_000_000;
const uuid = n => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
function record(n = 1) {
  const selection = { provider: 'local', model: 'example-model', baseUrl: 'http://192.0.2.10:8000/v1' };
  return { schemaVersion: 1, publisherId: uuid(n), sequence: 1, sessionId: `session-${n}`,
    title: 'Fixture', cwd: '/fixture/shared', selection, requestDestination: { ...selection },
    destinationEvidence: 'provider-matched', phase: 'idle', requestOpen: false,
    updatedAt: new Date(NOW).toISOString(), lastDeltaAt: null };
}
async function stateDir(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sparkdash-pi-helper-'));
  await fs.chmod(root, 0o700);
  const dir = path.join(root, 'pi-sparkdash-occupancy'); await fs.mkdir(dir, { mode: 0o700 });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, dir };
}
async function put(dir, r, at = NOW) {
  const file = path.join(dir, `${r.publisherId}.json`);
  await fs.writeFile(file, JSON.stringify(r), { mode: 0o600 });
  await fs.chmod(file, 0o600); await fs.utimes(file, new Date(at), new Date(at));
}
// No socket is opened: the helper's own request handler is driven directly.
async function call(helper, urlPath, authorization) {
  const req = { method: 'GET', url: urlPath, headers: authorization ? { authorization } : {} };
  const res = { statusCode: 0, headers: {}, body: '', setHeader(k, v) { this.headers[k] = v; }, end(b) { this.body = b; } };
  await helper.onRequest(req, res);
  return { status: res.statusCode, body: JSON.parse(res.body || '{}') };
}

test('catalog exposes Pi as a native harness distinct from oh-my-pi', () => {
  const pi = harnessById('pi');
  assert.equal(pi.transport, 'native'); assert.equal(pi.label, 'Pi');
  assert.equal(pi.commandEnv, null); assert.equal(pi.defaultCommand, null);
  assert.equal(harnessById('omp').label, 'oh-my-pi');
  assert.equal(HARNESSES.length, 6);
  assert.deepEqual(HARNESSES.filter(h => h.transport === 'acp').map(h => h.id), ['openclaw', 'opencode', 'omp']);
});

test('a Pi-only helper starts no ACP bridge, agent, Hermes or DSH reader', async t => {
  const { dir } = await stateDir(t); await put(dir, record());
  let spawns = 0, hermes = 0, dsh = 0;
  const helper = createOccupancyHelper({
    adapters: 'pi', piStateDir: dir, refreshMs: 60_000, now: () => NOW,
    openProcess: () => { spawns += 1; throw new Error('must not spawn'); },
    readDb: async () => { hermes += 1; return []; },
    fetchFn: async () => { dsh += 1; throw new Error('must not fetch'); },
  });
  try {
    await helper.refresh();
    assert.deepEqual(helper.adapters, ['pi']);
    assert.deepEqual(helper.spawnCounts(), { pi: 0 });
    assert.equal(spawns, 0); assert.equal(hermes, 0); assert.equal(dsh, 0);
    const body = helper.payload(NOW);
    assert.equal(body.rows.length, 1); assert.equal(body.rows[0].harness, 'pi');
    assert.equal(body.adapters.pi.coverage, 'supported');
  } finally { await helper.close(); }
});

test('concurrent authenticated reads are cache-only and never re-read the metadata directory', async t => {
  const { dir } = await stateDir(t); await put(dir, record());
  let reads = 0;
  const helper = createOccupancyHelper({ adapters: 'pi', piStateDir: dir, token: 'expected', refreshMs: 60_000,
    now: () => NOW, filesystem: { ...fs, opendir: (...a) => { reads += 1; return fs.opendir(...a); } } });
  try {
    await helper.refresh();
    const afterRefresh = reads;
    const results = await Promise.all(Array.from({ length: 8 }, () => call(helper, '/occupancy', 'Bearer expected')));
    assert.equal(results.every(r => r.status === 200 && r.body.rows.length === 1), true);
    assert.equal(reads, afterRefresh);
    const denied = await call(helper, '/occupancy', 'Bearer wrong');
    assert.equal(denied.status, 401); assert.equal(JSON.stringify(denied.body).includes('session-1'), false);
    assert.equal((await call(helper, '/health', 'Bearer expected')).body.rows, undefined);
  } finally { await helper.close(); }
});

test('a Pi-only helper still refuses an all-interface bind', () => {
  assert.throws(() => createOccupancyHelper({ adapters: 'pi', host: '0.0.0.0', token: 't' }).start(), /all interfaces/);
});

test('entrypoint detection survives a symlinked path', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sparkdash-pi-symlink-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const real = path.join(root, 'index.js');
  await fs.writeFile(real, '// fixture\n');
  const link = path.join(root, 'current-index.js');
  await fs.symlink(real, link);
  const moduleUrl = pathToFileURL(real).href;
  assert.equal(isMainModule(link, moduleUrl), true, 'a symlinked argv[1] must still be recognised');
  assert.equal(isMainModule(real, moduleUrl), true);
  assert.equal(isMainModule(path.join(root, 'other.js'), moduleUrl), false);
  assert.equal(isMainModule(undefined, moduleUrl), false);
  assert.equal(isMainModule(path.join(root, 'missing.js'), moduleUrl), false, 'a missing path must not throw');
});
