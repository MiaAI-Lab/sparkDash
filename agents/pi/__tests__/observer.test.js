import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { registerPiObserver, createPiPublisherState } from '../index.js';
import { createPiFileWriter } from '../writer.js';

const SPARK = { provider: 'local', id: 'example-model', api: 'openai-completions', baseUrl: 'http://192.0.2.10:8000/v1' };
const CLOUD = { provider: 'openai', id: 'cloud-model', api: 'openai-responses', baseUrl: 'https://chatgpt.com/backend-api' };

function fixture(shared = createPiPublisherState(), writer) {
  const hooks = new Map(), writes = [], timers = new Set();
  let now = 1_800_000_000_000;
  const schedule = (fn, ms, repeat = false) => {
    const task = { fn, due: now + ms, ms, repeat }; timers.add(task);
    return () => timers.delete(task);
  };
  const ctx = {
    cwd: '/fixture/shared',
    sessionManager: {
      getSessionId: () => 'fixture-session', getSessionName: () => 'Fixture',
      getSessionFile: () => { throw Error('Forbidden history'); },
      getEntries: () => { throw Error('Forbidden content'); },
    },
    model: new Proxy(SPARK, { get(o, k) { if (Object.hasOwn(o, k)) return o[k]; throw Error('Forbidden model field'); } }),
  };
  const controller = registerPiObserver({ on: (name, fn) => hooks.set(name, fn) }, {
    shared, now: () => now, schedule,
    writer: writer || { write: value => { writes.push(value); } },
  });
  const emit = (name, event) => hooks.get(name)(event ?? (name === 'message_end' ? { message: { role: 'assistant' } } : {}), ctx);
  const tick = ms => {
    const target = now + ms;
    for (;;) {
      const task = [...timers].filter(t => t.due <= target).sort((a, b) => a.due - b.due)[0];
      if (!task) break;
      now = task.due;
      if (task.repeat) task.due += task.ms; else timers.delete(task);
      task.fn();
    }
    now = target;
  };
  const begin = (model = SPARK) => {
    emit('session_start');
    emit('before_provider_request', new Proxy({}, { get() { throw Error('Forbidden payload'); } }));
    emit('provider_stream_event', new Proxy({ provider: model.provider, model: model.id, api: model.api }, {
      get(o, k) { if (Object.hasOwn(o, k)) return o[k]; throw Error('Forbidden stream data'); },
    }));
  };
  return { hooks, writes, timers, ctx, controller, emit, tick, begin, shared };
}

test('registration is inert and registers only the approved hooks', () => {
  const f = fixture();
  assert.equal(f.hooks.size, 13);
  assert.equal(f.writes.length, 0);
  assert.equal(f.timers.size, 0);
  assert.equal(f.controller.snapshot(), null);
});

test('a matching request is receiving, and only recognised deltas renew generation time', async () => {
  const f = fixture(); f.begin();
  assert.equal(f.controller.snapshot().destinationEvidence, 'provider-matched');
  assert.equal(f.controller.snapshot().requestDestination.baseUrl, 'http://192.0.2.10:8000/v1');
  assert.equal(f.controller.snapshot().lastDeltaAt, null);
  f.emit('message_update', { assistantMessageEvent: { type: 'text_start' } });
  assert.equal(f.controller.snapshot().lastDeltaAt, null);
  f.tick(10); f.emit('message_update', { assistantMessageEvent: { type: 'thinking_delta' } });
  assert.equal(f.controller.snapshot().lastDeltaAt, 1_800_000_000_010);
  await f.controller.stop();
});

test('any http(s) destination is published; the dashboard decides which card it belongs to', async () => {
  const f = fixture(); f.ctx.model = CLOUD; f.begin(CLOUD);
  assert.equal(f.controller.snapshot().requestDestination.baseUrl, 'https://chatgpt.com/backend-api');
  assert.equal(f.controller.snapshot().requestDestination.provider, 'openai');
  // Credentials, query strings and non-http schemes are not destinations.
  for (const baseUrl of ['https://user:pass@cloud.invalid/v1', 'https://cloud.invalid/v1?key=x', 'file:///etc/passwd']) {
    const g = fixture();
    g.ctx.model = { ...CLOUD, baseUrl };
    g.begin({ ...CLOUD, baseUrl });
    assert.equal(g.controller.snapshot().requestDestination.baseUrl, null, baseUrl);
    await g.controller.stop();
  }
  await f.controller.stop();
});

test('overlapping requests cannot reacquire proof until the agent settles', async () => {
  const f = fixture(); f.begin();
  f.emit('before_provider_request', {});
  f.emit('provider_stream_event', { provider: SPARK.provider, model: SPARK.id, api: SPARK.api });
  assert.equal(f.controller.snapshot().requestDestination, null);
  f.emit('message_end', { message: { role: 'assistant' } });
  f.emit('before_provider_request', {});
  f.emit('provider_stream_event', { provider: SPARK.provider, model: SPARK.id, api: SPARK.api });
  assert.equal(f.controller.snapshot().requestDestination, null);
  f.emit('agent_settled');
  f.emit('before_provider_request', {});
  f.emit('provider_stream_event', { provider: SPARK.provider, model: SPARK.id, api: SPARK.api });
  assert.equal(f.controller.snapshot().destinationEvidence, 'provider-matched');
  await f.controller.stop();
});

test('tools are their own phase, and only an assistant message end closes the request', async () => {
  const f = fixture(); f.begin();
  f.emit('tool_execution_start', { toolCallId: 'one' });
  assert.equal(f.controller.snapshot().phase, 'tools');
  f.emit('message_end', { message: { role: 'user' } });
  assert.equal(f.controller.snapshot().requestOpen, true);
  f.emit('message_end', { message: { role: 'assistant' } });
  assert.equal(f.controller.snapshot().requestOpen, false);
  assert.equal(f.controller.snapshot().lastDeltaAt, null);
  f.emit('agent_settled');
  assert.equal(f.controller.snapshot().phase, 'idle');
  await f.controller.stop();
});

test('a model switch revokes the destination, and a heartbeat never renews recency', async () => {
  const f = fixture(); f.begin();
  f.emit('message_update', { assistantMessageEvent: { type: 'text_delta' } });
  const before = f.controller.snapshot();
  f.tick(5000);
  assert.equal(f.controller.snapshot().updatedAt, before.updatedAt);
  assert.equal(f.controller.snapshot().lastDeltaAt, before.lastDeltaAt);
  assert.ok(f.controller.snapshot().sequence > before.sequence);
  f.emit('model_select');
  assert.equal(f.controller.snapshot().requestDestination, null);
  await f.controller.stop();
});

test('coalescing writes once per window and a reload keeps publisher identity', async () => {
  const one = fixture(); one.begin();
  for (let i = 0; i < 1000; i++) one.emit('message_update', { assistantMessageEvent: { type: 'thinking_delta' } });
  assert.equal(one.writes.length, 0);
  one.tick(250); await one.controller.flush();
  assert.equal(one.writes.length, 1);
  const before = one.writes.at(-1);
  const two = fixture(one.shared); two.emit('session_start'); two.tick(250); await two.controller.flush();
  assert.equal(one.timers.size, 0);
  assert.equal(two.controller.snapshot().publisherId, before.publisherId);
  assert.ok(two.controller.snapshot().sequence > before.sequence);
  assert.equal(two.controller.snapshot().requestDestination, null);
  await two.controller.stop();
});

test('a hung write cannot block shutdown, and faults never escape a hook', async () => {
  let release;
  const never = new Promise(resolve => { release = resolve; });
  let first = true;
  const f = fixture(undefined, { write: async () => { if (first) { first = false; await never; } } });
  f.begin(); f.tick(250); await Promise.resolve();
  const stopped = f.controller.stop(); f.tick(2000); await stopped;
  assert.equal(f.controller.snapshot(), null);
  assert.equal(f.timers.size, 0);
  release(); await f.controller.flush();
  Object.defineProperty(f.ctx, 'model', { get() { throw Error('Private failure text'); } });
  assert.doesNotThrow(() => f.emit('before_provider_request'));
});

test('the private writer publishes atomically and removes only its own record', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sparkdash-pi-writer-'));
  await fs.chmod(root, 0o700);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const id = '00000000-0000-4000-8000-000000000001';
  const writer = createPiFileWriter({ runtimeDir: root, publisherId: id });
  const dir = path.join(root, 'pi-sparkdash-occupancy');
  await assert.rejects(fs.stat(dir), { code: 'ENOENT' });
  await writer.write({ schemaVersion: 1, publisherId: id, sequence: 1 });
  const file = path.join(dir, `${id}.json`);
  assert.equal((await fs.stat(dir)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  await fs.writeFile(path.join(dir, 'other.json'), 'fixture', { mode: 0o600 });
  await writer.write(null);
  await assert.rejects(fs.stat(file), { code: 'ENOENT' });
  assert.equal(await fs.readFile(path.join(dir, 'other.json'), 'utf8'), 'fixture');
  assert.throws(() => createPiFileWriter({ runtimeDir: root, publisherId: '../escape' }), /Pi occupancy metadata unavailable/);
});

test('the default writer composes with the real scheduler and removes the file on shutdown', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sparkdash-pi-native-'));
  await fs.chmod(root, 0o700);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const hooks = new Map();
  const controller = registerPiObserver({ on: (kind, fn) => hooks.set(kind, fn) }, { runtimeDir: root });
  const { ctx } = fixture();
  hooks.get('session_start')({}, ctx);
  await controller.flush();
  const dir = path.join(root, 'pi-sparkdash-occupancy');
  const files = await fs.readdir(dir);
  assert.equal(files.length, 1);
  const data = JSON.parse(await fs.readFile(path.join(dir, files[0]), 'utf8'));
  assert.equal(data.sessionId, 'fixture-session');
  assert.equal(data.destinationEvidence, 'none');
  assert.equal((await fs.stat(path.join(dir, files[0]))).mode & 0o777, 0o600);
  await hooks.get('session_shutdown')({}, ctx);
  assert.deepEqual(await fs.readdir(dir), []);
});
