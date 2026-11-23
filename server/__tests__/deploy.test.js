import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const deploy = resolve('deploy.sh');

test('deploy retries a failed build before replacing the running service', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sparkdash-deploy-'));
  try {
    const log = join(dir, 'calls');
    writeFileSync(join(dir, 'docker'), `#!/bin/sh
printf '%s\\n' "$*" >> "$DEPLOY_TEST_LOG"
case "$*" in
  'compose build') exit 1 ;;
  'compose config --images') echo custom-image ;;
  'create custom-image') echo temporary-container ;;
esac
`, { mode: 0o755 });
    const result = spawnSync('bash', [deploy], {
      cwd: dir,
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, DEPLOY_TEST_LOG: log },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n'), [
      'compose build',
      'compose build --build-arg NODE_IMAGE=node:22-bookworm-slim',
      'compose config --images',
      'create custom-image',
      'cp temporary-container:/app/dist/. ./dist/',
      'rm temporary-container',
      'compose up -d --no-build',
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
