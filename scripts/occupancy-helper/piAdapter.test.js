import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadPi } from './piAdapter.js';

const NOW = 1_800_000_000_000;
const uuid = n => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
function record(n = 1, cloud = false) {
  const selection = cloud ? { provider: 'openai', model: 'cloud-model', baseUrl: 'https://chatgpt.com/backend-api' }
    : { provider: 'local', model: 'example-model', baseUrl: 'http://192.0.2.10:8000/v1' };
  return { schemaVersion: 1, publisherId: uuid(n), sequence: 1, sessionId: `session-${n}`,
    title: 'Fixture', cwd: '/fixture/shared', selection, requestDestination: { ...selection },
    destinationEvidence: 'provider-matched', phase: 'idle', requestOpen: false,
    updatedAt: new Date(NOW).toISOString(), lastDeltaAt: null };
}
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sparkdash-pi-adapter-'));
  await fs.chmod(root, 0o700);
  const dir = path.join(root, 'pi-sparkdash-occupancy'); await fs.mkdir(dir, { mode: 0o700 });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const seen = new Map();
  async function put(r, at = NOW, bytes = JSON.stringify(r)) {
    const file = path.join(dir, `${r.publisherId}.json`);
    await fs.writeFile(file, bytes, { mode: 0o600 }); await fs.chmod(file, 0o600);
    await fs.utimes(file, new Date(at), new Date(at));
    return file;
  }
  return { root, dir, seen, put, read: (now = NOW, extra = {}) => loadPi({ stateDir: dir, now, seen, ...extra }) };
}

test('Spark and cloud rows share a folder but keep distinct publisher identities and stat timestamps', async t => {
  const f = await fixture(t); await f.put(record(1)); await f.put(record(2, true));
  const out = await f.read(NOW + 1000);
  assert.equal(out.coverage, 'supported'); assert.equal(out.rows.length, 2);
  const spark = out.rows.find(r => r.selection.provider === 'local');
  const cloud = out.rows.find(r => r.selection.provider === 'openai');
  assert.equal(spark.harness, 'pi'); assert.equal(spark.sessionId, `session-1:${uuid(1)}`);
  assert.equal(cloud.requestDestination.baseUrl, 'https://chatgpt.com/backend-api');
  assert.equal(spark.cwd, cloud.cwd); assert.equal(spark.lastSeenAt, NOW);
  assert.equal('origin' in spark, false); assert.equal('activity' in spark, false);
  spark.selection.provider = 'changed-by-caller';
  assert.equal((await f.read()).rows.find(r => r.sessionId === spark.sessionId).selection.provider, 'local');
});

test('selection-only and missing selection are valid unbound records', async t => {
  const f = await fixture(t), r = record(); r.selection = null; r.requestDestination = null; r.destinationEvidence = 'none';
  await f.put(r); const out = await f.read();
  assert.equal(out.rows.length, 1); assert.equal(out.rows[0].requestDestination, null);
});

test('extra content, credentials, non-http URLs and mismatched proof are rejected without echoing fields', async t => {
  const f = await fixture(t);
  const invalid = [
    r => { r.payload = 'FIXTURE-CONTENT-CANARY'; },
    r => { r.selection.apiKey = 'FIXTURE-CONTENT-CANARY'; },
    r => { r.selection.baseUrl = 'https://user:pass@private.invalid/FIXTURE-CONTENT-CANARY'; },
    r => { r.selection.baseUrl = 'file:///FIXTURE-CONTENT-CANARY'; },
    r => { r.requestDestination.provider = 'different'; },
    r => { r.origin = { host: '192.0.2.10', port: 8000 }; },
    r => { r.lastSeenAt = NOW; },
    r => { r.sequence = 0; },
  ];
  for (const mutate of invalid) {
    const r = record(); mutate(r); await f.put(r);
    const out = await f.read(); assert.equal(out.rows.length, 0);
    assert.equal(out.coverage, 'partial'); assert.equal(JSON.stringify(out).includes('CANARY'), false);
  }
});

test('invalid, missing and more-than-five-second-future timestamps fail closed', async t => {
  const f = await fixture(t);
  for (const mutate of [
    r => { delete r.updatedAt; }, r => { delete r.lastDeltaAt; },
    r => { r.updatedAt = 'invalid'; }, r => { r.updatedAt = new Date(NOW + 5001).toISOString(); },
    r => { r.lastDeltaAt = NOW + 5001; }, r => { r.lastDeltaAt = 'now'; },
  ]) {
    const r = record(); mutate(r); await f.put(r); assert.equal((await f.read()).rows.length, 0);
  }
  await f.put(record(), NOW + 5001); assert.equal((await f.read()).rows.length, 0);
});

test('symlinks, directories, unsafe modes and wrong owner never open their content', async t => {
  const f = await fixture(t), r = record();
  const file = path.join(f.dir, `${r.publisherId}.json`);
  const sentinel = path.join(f.root, 'history-sentinel'); await fs.writeFile(sentinel, 'FIXTURE-CONTENT-CANARY');
  await fs.symlink(sentinel, file);
  let opens = 0;
  const filesystem = { ...fs, open: (...args) => { opens++; return fs.open(...args); } };
  assert.equal((await f.read(NOW, { filesystem })).rows.length, 0); assert.equal(opens, 0);
  await fs.unlink(file); await fs.mkdir(file, { mode: 0o700 });
  assert.equal((await f.read(NOW, { filesystem })).rows.length, 0); assert.equal(opens, 0);
  await fs.rmdir(file); await f.put(r); await fs.chmod(file, 0o644);
  assert.equal((await f.read(NOW, { filesystem })).rows.length, 0); assert.equal(opens, 0);
  await fs.chmod(file, 0o600);
  const wrongOwner = { ...filesystem, lstat: async p => {
    const s = await fs.lstat(p); if (p === file) s.uid++; return s;
  } };
  assert.equal((await f.read(NOW, { filesystem: wrongOwner })).rows.length, 0); assert.equal(opens, 0);
});

test('oversize, corrupt and invalid UTF-8 files are rejected with fixed errors', async t => {
  const f = await fixture(t), r = record();
  for (const bytes of ['x'.repeat(16385), '{bad', Buffer.from([0xff, 0xfe])]) {
    await f.put(r, NOW, bytes); const out = await f.read();
    assert.equal(out.rows.length, 0); assert.equal(out.coverage, 'partial');
    assert.equal(JSON.stringify(out).includes('{bad'), false);
  }
});

test('reading a file is not activity: repeated reads and touches keep the original timestamps', async t => {
  const f = await fixture(t), r = record(); await f.put(r);
  assert.equal((await f.read()).rows[0].lastSeenAt, NOW);
  assert.equal((await f.read(NOW + 1000)).rows[0].lastSeenAt, NOW);
  await f.put(r, NOW + 20_000);
  assert.equal((await f.read(NOW + 20_000)).rows[0].lastSeenAt, NOW);
  assert.equal((await f.read(NOW + 120_001)).rows.length, 0);
  await f.put(r, NOW + 120_002); assert.equal((await f.read(NOW + 120_002)).rows.length, 0);
  r.sequence++; r.updatedAt = new Date(NOW + 120_003).toISOString();
  await f.put(r, NOW + 120_003); assert.equal((await f.read(NOW + 120_003)).rows.length, 1);
  const forged = record(1, true); forged.sequence = r.sequence; forged.updatedAt = new Date(NOW + 120_004).toISOString();
  await f.put(forged, NOW + 120_004); assert.equal((await f.read(NOW + 120_004)).rows.length, 0);
});

test('a crashed session file expires on its own clock', async t => {
  const f = await fixture(t); await f.put(record());
  assert.equal((await f.read(NOW + 45_001)).rows[0].lastSeenAt, NOW);
  assert.equal((await f.read(NOW + 120_000)).rows.length, 1);
  assert.equal((await f.read(NOW + 120_001)).rows.length, 0);
});

test('expired records and temporary names never consume the 500 live-row capacity', async t => {
  const f = await fixture(t);
  for (let i = 1; i <= 510; i++) await f.put(record(i), NOW - 120_001);
  await f.put(record(511)); await f.put(record(512, true));
  await fs.writeFile(path.join(f.dir, '.ignored.tmp'), 'FIXTURE-CONTENT-CANARY');
  let opens = 0;
  const filesystem = { ...fs, open: (...args) => { opens++; return fs.open(...args); } };
  const out = await f.read(NOW, { filesystem });
  assert.equal(out.coverage, 'supported'); assert.equal(out.rows.length, 2);
  // Expired records are skipped from stat alone: their content is never opened.
  assert.equal(opens, 2);
});

test('more than 500 live rows fails loudly, not a truncated active claim', async t => {
  const f = await fixture(t);
  for (let i = 1; i <= 501; i++) await f.put(record(i));
  const out = await f.read(); assert.equal(out.coverage, 'unavailable'); assert.equal(out.rows.length, 0);
  assert.match(out.error, /capacity/i);
});

// Directory entries with stat-only content: no disk cost, and enough of them to
// cross the scan bound a real directory would need thousands of crashed files
// to reach.
function patchedFilesystem({ dir, names, mtimeMs, synthetic = names }) {
  const stat = new Map(synthetic.map(name => [path.join(dir, name), { uid: process.getuid(), mode: 0o600,
    mtimeMs, size: 512, ino: 9, dev: 9, isFile: () => true, isDirectory: () => false,
    isSymbolicLink: () => false }]));
  return { ...fs,
    opendir: async () => (async function* () { for (const name of names) yield { name }; })(),
    lstat: async p => stat.get(p) || fs.lstat(p) };
}

test('where crashed sessions have left expired files behind, the adapter still reads live ones', async t => {
  const f = await fixture(t);
  // Before this fix, 2000 directory entries made the whole adapter unavailable.
  for (let i = 1; i <= 2100; i++) await f.put(record(i), NOW - 120_001);
  await f.put(record(2101));
  let opens = 0;
  const filesystem = { ...fs, open: (...args) => { opens++; return fs.open(...args); } };
  const out = await f.read(NOW, { filesystem });
  assert.equal(out.coverage, 'supported'); assert.equal(out.error, null);
  assert.equal(out.rows.length, 1); assert.equal(out.rows[0].sessionId, `session-2101:${uuid(2101)}`);
  assert.equal(opens, 1, 'expired files are skipped from stat alone');
});

test('live metadata files still stop at the directory capacity', async t => {
  const f = await fixture(t);
  const names = Array.from({ length: 2001 }, (_, i) => `${uuid(i + 1)}.json`);
  const out = await f.read(NOW, { filesystem: patchedFilesystem({ dir: f.dir, names, mtimeMs: NOW }) });
  assert.equal(out.coverage, 'unavailable'); assert.equal(out.rows.length, 0);
  assert.match(out.error, /capacity/i);
});

test('a directory that never ends costs a bounded scan: live rows are kept and the rest is partial', async t => {
  const f = await fixture(t), r = record();
  const file = await f.put(r);
  const names = [path.basename(file),
    ...Array.from({ length: 20_000 }, (_, i) => `${uuid(i + 1000)}.json`)];
  const out = await f.read(NOW, { filesystem: patchedFilesystem({
    dir: f.dir, names, synthetic: names.slice(1), mtimeMs: NOW - 120_001 }) });
  assert.equal(out.coverage, 'partial'); assert.match(out.error, /scan/i);
  assert.equal(out.rows.length, 1); assert.equal(out.rows[0].sessionId, r.sessionId + ':' + r.publisherId);
});

test('missing/relative/non-private/state-history paths are unavailable without a history fallback', async t => {
  const f = await fixture(t);
  for (const stateDir of [path.join(f.root, 'missing'), 'relative', path.join(f.root, 'sessions')]) {
    assert.equal((await loadPi({ stateDir, now: NOW })).coverage, 'unavailable');
  }
  await fs.chmod(f.dir, 0o755); assert.equal((await f.read()).coverage, 'unavailable');
});

test('filename must match the publisher; sequence regression is rejected', async t => {
  const f = await fixture(t), r = record(); await f.put(r);
  const file = path.join(f.dir, `${r.publisherId}.json`);
  await fs.rename(file, path.join(f.dir, `${uuid(2)}.json`)); assert.equal((await f.read()).rows.length, 0);
  await fs.unlink(path.join(f.dir, `${uuid(2)}.json`));
  r.sequence = 2; await f.put(r); assert.equal((await f.read()).rows.length, 1);
  r.sequence = 1; await f.put(r); assert.equal((await f.read()).rows.length, 0);
});
