#!/usr/bin/env node
// Explicit instrumentation only. This observes a command; it does NOT sandbox or approve it.
import { spawn } from 'node:child_process';
import { constants } from 'node:os';
import { appendObservation, observation, parseOptions } from '../../server/overseer/journal.js';

try {
  const options = parseOptions(process.argv.slice(2));
  if (!options.command.length) throw Error('Provide a command after --');
  const event = observation(options.command, options);
  const record = data => {
    try { appendObservation(options.journal, data); }
    catch { process.stderr.write('[Spark Overseer] Observation unavailable; command is NOT protected.\n'); }
  };
  record(event);
  const child = spawn(options.command[0], options.command.slice(1), { stdio: 'inherit', shell: false });
  let killTimer;
  const forward = signal => {
    if (child.exitCode != null || child.signalCode) return;
    child.kill(signal);
    if (!killTimer) { killTimer = setTimeout(() => child.kill('SIGKILL'), 1000); killTimer.unref(); }
  };
  const onTerm = () => forward('SIGTERM');
  const onInt = () => forward('SIGINT');
  process.on('SIGTERM', onTerm);
  process.on('SIGINT', onInt);
  child.on('error', () => {
    clearTimeout(killTimer);
    record({ ...event, timestamp: Date.now(), finished: true, exitCode: 127 });
    process.exitCode = 127;
  });
  child.on('exit', (code, signal) => {
    clearTimeout(killTimer);
    process.removeListener('SIGTERM', onTerm);
    process.removeListener('SIGINT', onInt);
    const exitCode = code ?? (128 + (constants.signals[signal] ?? 15));
    record({ ...event, timestamp: Date.now(), finished: true, exitCode });
    process.exitCode = exitCode;
  });
} catch {
  process.stderr.write('Usage: observe-run.mjs --journal /absolute/events.ndjson [--model model-id] [--allow-host hostname] -- command args...\n');
  process.exitCode = 2;
}
