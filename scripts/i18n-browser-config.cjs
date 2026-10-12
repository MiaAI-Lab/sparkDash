const os = require('node:os');
const nativePath = require('node:path');
const ownedProfiles = new Map();

function isUsableExecutable(file, { fs, platform }) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return false;
    if (platform !== 'win32' && fs.constants?.X_OK !== undefined) fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function pathCandidates(name, { env, path }) {
  return (env.PATH || '').split(path.delimiter).filter(Boolean).map(directory => path.join(directory, name));
}

function installedCandidates({ platform, env, path }) {
  if (platform === 'win32') {
    const roots = [env['ProgramFiles(x86)'], env.ProgramFiles, env.LOCALAPPDATA].filter(Boolean);
    const locations = [
      ['Microsoft', 'Edge', 'Application', 'msedge.exe'],
      ['Google', 'Chrome', 'Application', 'chrome.exe'],
      ['Chromium', 'Application', 'chrome.exe'],
    ];
    return locations.flatMap(parts => roots.map(root => path.join(root, ...parts)));
  }
  if (platform === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ];
  }
  return ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'microsoft-edge-stable']
    .flatMap(name => pathCandidates(name, { env, path }));
}

function resolveBrowserConfig(options = {}) {
  const fs = options.fs || require('node:fs');
  const path = options.path || nativePath;
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  const repo = options.repo || process.cwd();
  const out = env.I18N_BROWSER_OUT || path.join(repo, '.omx', 'i18n-browser');
  const requested = env.I18N_BROWSER_BINARY;
  if (requested) {
    if (!isUsableExecutable(requested, { fs, platform })) {
      throw new Error(`I18N_BROWSER_BINARY is not an executable file: ${requested}`);
    }
    return { binary: requested, out, source: 'I18N_BROWSER_BINARY' };
  }
  const binary = installedCandidates({ platform, env, path }).find(file => isUsableExecutable(file, { fs, platform }));
  if (!binary) {
    throw new Error('No installed Chromium, Chrome, or Edge executable was found. Set I18N_BROWSER_BINARY to its executable path.');
  }
  return { binary, out, source: 'installed browser discovery' };
}

function createBrowserProfile(options = {}) {
  const fs = options.fs || require('node:fs');
  const path = options.path || nativePath;
  const tmpdir = options.tmpdir || os.tmpdir;
  const root = path.resolve(tmpdir());
  const prefix = 'sparkdash-i18n-browser-';
  const profile = path.resolve(fs.mkdtempSync(path.join(root, prefix)));
  if (path.dirname(profile) !== root || !path.basename(profile).startsWith(prefix)) {
    throw new Error('Browser profile was not created directly inside the OS temporary directory');
  }
  ownedProfiles.set(profile, root);
  return profile;
}

function removeBrowserProfile(profile, options = {}) {
  if (!profile) return false;
  const fs = options.fs || require('node:fs');
  const path = options.path || nativePath;
  const resolved = path.resolve(profile);
  const root = ownedProfiles.get(resolved);
  if (!root || path.dirname(resolved) !== root || !path.basename(resolved).startsWith('sparkdash-i18n-browser-')) return false;
  fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 3 });
  ownedProfiles.delete(resolved);
  return true;
}

function sandboxArguments({ platform = process.platform, uid = process.getuid?.(), env = process.env } = {}) {
  return platform === 'linux' && (env.I18N_BROWSER_NO_SANDBOX === '1' || uid === 0) ? ['--no-sandbox'] : [];
}

module.exports = { createBrowserProfile, installedCandidates, removeBrowserProfile, resolveBrowserConfig, sandboxArguments };
