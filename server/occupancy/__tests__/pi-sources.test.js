import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isolatedConfigEnv } from '../../__tests__/isolatedEnv.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sparkdash-pi-sources-'));
Object.assign(process.env, isolatedConfigEnv(root));
process.env.SPARKDASH_SECRETS_KEY = 'pi-sources-test-key';
delete process.env.SPARKDASH_TOKEN;

const { replaceHelpers, loadHelpers } = await import('../sources.js');

const sparks = [{ id: 'dgx-spark', name: 'DGX Spark', llmPorts: [8000] }];
const body = (extra = {}) => ({ id: 'workstation', label: 'Workstation', url: 'http://127.0.0.1:8790/occupancy',
  enabled: true, harnesses: ['pi'], routes: [], ...extra });

test('new Pi routes are rejected and legacy Pi routes are stripped on read', () => {
  assert.throws(() => replaceHelpers([body({ routes: [{ harness: 'pi', sparkId: 'dgx-spark', port: 8000 }] })], { sparks }),
    /Pi routes/);
  assert.throws(() => replaceHelpers([body({ routes: [{ harness: 'pi', sparkId: 'dgx-spark', port: 8000, cwdPrefix: '/x' }] })], { sparks }),
    /Pi routes/);
  // A file written by an older build must not fail unrelated edits.
  fs.writeFileSync(process.env.OCCUPANCY_HELPERS_JSON_PATH, JSON.stringify({ helpers: [
    { ...body(), routes: [{ harness: 'pi', sparkId: 'dgx-spark', port: 8000 }] },
  ] }, null, 2));
  const [stored] = loadHelpers();
  assert.deepEqual(stored.routes, []);
  const [saved] = replaceHelpers([{ ...stored, label: 'Renamed' }], { sparks });
  assert.equal(saved.label, 'Renamed');
  assert.deepEqual(saved.routes, []);
});

test('unrelated harness routes survive a Pi edit', () => {
  replaceHelpers([body({ harnesses: ['pi', 'hermes'],
    routes: [{ harness: 'hermes', sparkId: 'dgx-spark', port: 8000, cwdPrefix: '/work' }] })], { sparks });
  const [helper] = replaceHelpers([body({ harnesses: ['pi', 'hermes'], label: 'Workstation 2',
    routes: [{ harness: 'hermes', sparkId: 'dgx-spark', port: 8000, cwdPrefix: '/work' }] })], { sparks });
  assert.equal(helper.label, 'Workstation 2');
  assert.deepEqual(helper.routes, [{ harness: 'hermes', sparkId: 'dgx-spark', port: 8000, cwdPrefix: '/work' }]);
});
