const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const { createBrowserProfile, removeBrowserProfile, resolveBrowserConfig, sandboxArguments } = require('../i18n-browser-config.cjs');

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
