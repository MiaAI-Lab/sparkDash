const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createBrowserProfile, removeBrowserProfile, resolveBrowserConfig, sandboxArguments, stopBrowser } = require('../i18n-browser-config.cjs');

function fakeFs(files) {
  return {
    constants: { X_OK: 1 },
    statSync(file) { if (!files.has(file)) throw new Error('missing'); return { isFile: () => true }; },
    accessSync(file) { if (files.get(file) === 'not-executable') throw new Error('not executable'); },
  };
}

test('uses and validates I18N_BROWSER_BINARY before discovery', () => {
  const binary = 'C:/custom/browser.exe';
  const config = resolveBrowserConfig({ platform: 'win32', env: { I18N_BROWSER_BINARY: binary }, repo: 'repo', fs: fakeFs(new Map([[binary, true]])), path });
  assert.deepEqual(config, { binary, out: path.join('repo', '.omx', 'i18n-browser'), source: 'I18N_BROWSER_BINARY' });
  assert.throws(() => resolveBrowserConfig({ platform: 'win32', env: { I18N_BROWSER_BINARY: 'C:/missing.exe' }, repo: 'repo', fs: fakeFs(new Map()), path }), /I18N_BROWSER_BINARY is not an executable/);
});

test('discovers Linux browsers from PATH and reports a useful early failure', () => {
  const chrome = path.join('/tools', 'google-chrome');
  const config = resolveBrowserConfig({ platform: 'linux', env: { PATH: '/tools' }, repo: '/repo', fs: fakeFs(new Map([[chrome, true]])), path });
  assert.equal(config.binary, chrome);
  assert.equal(config.out, path.join('/repo', '.omx', 'i18n-browser'));
  assert.throws(() => resolveBrowserConfig({ platform: 'linux', env: { PATH: '/empty' }, fs: fakeFs(new Map()), path }), /No installed Chromium, Chrome, or Edge/);
});

test('discovers installed Edge or Chrome on Windows and macOS', () => {
  const edge = path.join('/Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe');
  const windows = resolveBrowserConfig({ platform: 'win32', env: { ProgramFiles: '/Program Files' }, fs: fakeFs(new Map([[edge, true]])), path });
  assert.equal(windows.binary, edge);
  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const mac = resolveBrowserConfig({ platform: 'darwin', env: {}, fs: fakeFs(new Map([[chrome, true]])), path });
  assert.equal(mac.binary, chrome);
});

test('honors explicit output and creates an isolated OS temporary profile', () => {
  const binary = '/browser';
  const config = resolveBrowserConfig({ platform: 'linux', env: { I18N_BROWSER_BINARY: binary, I18N_BROWSER_OUT: '/artifacts' }, fs: fakeFs(new Map([[binary, true]])), path });
  assert.equal(config.out, '/artifacts');
  let prefix;
  const profile = createBrowserProfile({ path, tmpdir: () => '/tmp', fs: { mkdtempSync(value) { prefix = value; return '/tmp/sparkdash-i18n-browser-123'; } } });
  assert.equal(prefix, path.join(path.resolve('/tmp'), 'sparkdash-i18n-browser-'));
  assert.equal(profile, path.resolve('/tmp/sparkdash-i18n-browser-123'));
});

test('removes only the temporary profile that this module created', () => {
  const profile = path.resolve('/tmp/sparkdash-i18n-browser-owned');
  const removed = [];
  const fs = {
    mkdtempSync: () => profile,
    rmSync: (target, options) => removed.push({ target, options }),
  };
  assert.equal(createBrowserProfile({ path, tmpdir: () => '/tmp', fs }), profile);
  assert.equal(removeBrowserProfile(path.resolve('/tmp/sparkdash-i18n-browser-foreign'), { path, fs }), false);
  assert.equal(removeBrowserProfile(path.resolve('/other/sparkdash-i18n-browser-owned'), { path, fs }), false);
  assert.deepEqual(removed, []);
  assert.equal(removeBrowserProfile(profile, { path, fs }), true);
  assert.equal(removed.length, 1);
  assert.equal(removed[0].target, profile);
  assert.equal(removeBrowserProfile(profile, { path, fs }), false);
});

test('adds --no-sandbox only for opt-in or root Linux runs', () => {
  assert.deepEqual(sandboxArguments({ platform: 'linux', uid: 1000, env: {} }), []);
  assert.deepEqual(sandboxArguments({ platform: 'linux', uid: 0, env: {} }), ['--no-sandbox']);
  assert.deepEqual(sandboxArguments({ platform: 'linux', uid: 1000, env: { I18N_BROWSER_NO_SANDBOX: '1' } }), ['--no-sandbox']);
  assert.deepEqual(sandboxArguments({ platform: 'win32', uid: 0, env: {} }), []);
});

test('rejects an explicitly configured non-executable Unix browser', () => {
  assert.throws(() => resolveBrowserConfig({ platform: 'linux', env: { I18N_BROWSER_BINARY: '/browser' }, fs: fakeFs(new Map([['/browser', 'not-executable']])), path }), /not an executable/);
});

test('waits for browser exit before deleting the profile it could still write to', async () => {
  const browser = Object.assign(new EventEmitter(), { pid: 123, exitCode: null, signalCode: null });
  const events = [];
  browser.kill = () => { events.push('stop requested'); };
  const fs = { mkdtempSync: () => '/tmp/sparkdash-i18n-browser-closing', rmSync: () => events.push('profile deleted') };
  const profile = createBrowserProfile({ path, tmpdir: () => '/tmp', fs });
  const cleanup = stopBrowser(browser).then(() => removeBrowserProfile(profile, { path, fs }));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(events, ['stop requested']);
  events.push('last browser write');
  browser.exitCode = 0;
  browser.emit('close', 0);
  assert.equal(await cleanup, true);
  assert.deepEqual(events, ['stop requested', 'last browser write', 'profile deleted']);
  assert.equal(browser.listenerCount('close'), 0);
});

test('browser cleanup tolerates failed launches and already exited processes', async () => {
  await stopBrowser(undefined);
  await stopBrowser({ pid: undefined });
  await stopBrowser({ pid: 123, exitCode: 0, signalCode: null, kill() { assert.fail('already exited'); } });
});

test('an unresponsive browser causes bounded cleanup failure instead of unsafe profile deletion', async () => {
  const browser = Object.assign(new EventEmitter(), { pid: 123, exitCode: null, signalCode: null });
  const signals = [];
  browser.kill = (signal = 'SIGTERM') => signals.push(signal);
  await assert.rejects(stopBrowser(browser, { timeoutMs: 30, killAfterMs: 5 }), /temporary profile was retained/);
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(browser.listenerCount('close'), 0);
  assert.equal(browser.listenerCount('error'), 0);
});
