import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { analyzeAction, safeModel } from './signals.js';

export const MAX_JOURNAL_BYTES = 4 * 1024 * 1024;
export function appendObservation(file, event) {
  if (!path.isAbsolute(file)) throw Error('Journal path must be absolute');
  const fd = fs.openSync(file, fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK, 0o600);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o022) || (process.getuid && stat.uid !== process.getuid())) throw Error('Unsafe journal permissions');
    const line = JSON.stringify(event) + '\n';
    if (stat.size + Buffer.byteLength(line) > MAX_JOURNAL_BYTES) throw Error('Journal capacity reached; rotate it explicitly');
    fs.writeSync(fd, line);
  } finally { fs.closeSync(fd); }
}
export function observation(input, { model, allowedHosts, kind = 'execution', id = randomUUID() } = {}) {
  return { version: 1, id, timestamp: Date.now(), kind, model: safeModel(model), ...analyzeAction(input, { allowedHosts }) };
}

export function parseOptions(argv) {
  const options = { allowedHosts: [], model: 'unspecified' };
  let i = 0;
  for (; i < argv.length && argv[i] !== '--'; i += 2) {
    const value = argv[i + 1];
    if (!value || value.startsWith('--')) throw Error('Missing observer option');
    if (argv[i] === '--journal') options.journal = value;
    else if (argv[i] === '--model') options.model = value;
    else if (argv[i] === '--allow-host') options.allowedHosts.push(value);
    else throw Error('Unknown observer option');
  }
  if (!options.journal || !path.isAbsolute(options.journal)) throw Error('An absolute --journal path is required');
  return { ...options, command: argv.slice(argv[i] === '--' ? i + 1 : i) };
}
