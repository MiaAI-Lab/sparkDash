import test from 'node:test';
import assert from 'node:assert/strict';
import { registerAtticInstallRoute, INSTALL_PROGRAM } from '../attic/install.js';

function setup(run = async () => {}) {
  let handler;
  const spark = { id: 's1', atticMonitoring: true, ssh: { user: 'user' } };
  registerAtticInstallRoute({ get: () => {}, post: (_path, fn) => { handler = fn; } }, {
    registry: { getSpark: () => spark }, allowChange: () => true, rejectLimited() {}, run,
  });
  const call = async (body, headers = {}) => {
    const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; return this; } };
    await handler({ body, params: { id: 's1' }, headers, socket: { remoteAddress: '127.0.0.1' } }, res);
    return res;
  };
  return { call, spark };
}

test('installation requires confirmation, supported Spark and enabled monitoring', async () => {
  let calls = 0;
  const { call, spark } = setup(async () => { calls++; });
  assert.equal((await call({})).statusCode, 400);
  assert.equal((await call({ confirm: true })).statusCode, 400);
  spark.kind = 'host';
  assert.equal((await call({ confirm: true, stopDesktopConfirmed: true })).statusCode, 400);
  spark.kind = 'spark'; spark.atticMonitoring = false;
  assert.equal((await call({ confirm: true, stopDesktopConfirmed: true })).statusCode, 400);
  assert.equal(calls, 0);
});

test('confirmed install sends password through runner input and reports failure', async () => {
  let args;
  const { call } = setup(async (...a) => { args = a; throw new Error('failed safely'); });
  const res = await call({ confirm: true, stopDesktopConfirmed: true, sudoPassword: 'secret' });
  assert.equal(res.statusCode, 502);
  assert.match(res.body.error, /failed safely/);
  assert.equal(args[2].input, 'secret');
  assert.ok(!args[1].includes('secret'));
  assert.match(INSTALL_PROGRAM, /sha256sum -c/);
  assert.match(INSTALL_PROGRAM, /Validation failed: CUDA_ERROR_OUT_OF_MEMORY/);
  assert.ok(INSTALL_PROGRAM.indexOf('--check --plain') < INSTALL_PROGRAM.indexOf('systemctl stop display-manager.service'));
  assert.ok(INSTALL_PROGRAM.indexOf('systemctl stop display-manager.service') < INSTALL_PROGRAM.lastIndexOf('bash "$tmp/install.sh" --plain'));
});

test('refuses a password on a relayed HTTP connection', async () => {
  let calls = 0;
  const { call } = setup(async () => { calls++; });
  const res = await call({ confirm: true, stopDesktopConfirmed: true, sudoPassword: 'secret' }, { 'x-forwarded-for': '10.0.0.2' });
  assert.equal(res.statusCode, 400);
  assert.equal(calls, 0);
});


test('status distinguishes an installed service from missing and unknown results', async () => {
  let handler;
  let result;
  registerAtticInstallRoute({ get: (path, fn) => { if (path.endsWith('/status')) handler = fn; }, post() {} }, {
    registry: { getSpark: () => ({ id: 's1' }) }, allowChange: () => true, rejectLimited() {},
    probe: async () => result,
  });
  const call = async () => {
    const res = { json(body) { this.body = body; return this; } };
    await handler({ params: { id: 's1' } }, res);
    return res.body;
  };
  result = { available: true, atticd: { present: true } };
  assert.deepEqual(await call(), { installed: true });
  result = { available: true, atticd: { present: false } };
  assert.deepEqual(await call(), { installed: false });
  result = { available: false, atticd: { present: null } };
  assert.deepEqual(await call(), { installed: null });
});

test('local installer surfaces failed full-check details ahead of routine preflight output', async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { spawnSync } = await import('node:child_process');
  const dir = mkdtempSync(join(tmpdir(), 'attic-error-'));
  try {
    const script = (name, content) => writeFileSync(join(dir, name), `#!/bin/sh\n${content}\n`, { mode: 0o755 });
    script('id', 'echo 0');
    script('systemctl', 'exit 1');
    script('curl', 'while [ "$1" != "-o" ]; do shift; done; shift; : > "$1"');
    script('sha256sum', 'exit 0');
    script('bash', 'case "$*" in *--check*) printf "ok routine preflight\\n"; exit 0;; *) echo "FAIL validation"; exit 1;; esac');
    script('find', 'printf \'%s\\n\' \'{"full":{"pass":false,"size":532676608,"why":""}}\'');
    const product = join(dir, 'product-name');
    const program = INSTALL_PROGRAM.replace('/sys/class/dmi/id/product_name', product);
    writeFileSync(product, 'Other GB10');
    const run = () => spawnSync('sh', ['-c', program], {
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}` }, encoding: 'utf8',
    });
    const out = run();
    assert.notEqual(out.status, 0);
    assert.match(out.stderr, /full carveout memory check failed \(available carveout: 508 MiB\)/);
    assert.doesNotMatch(out.stderr, /ok routine preflight/);
    writeFileSync(product, 'NVIDIA_DGX_Spark');
    const founders = run();
    assert.notEqual(founders.status, 0);
    assert.match(founders.stderr, /A Founders Edition DGX Spark has been detected\. The display memory reserve is already disabled through BIOS\./);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
