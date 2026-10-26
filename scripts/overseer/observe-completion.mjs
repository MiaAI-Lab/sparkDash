#!/usr/bin/env node
// Pipe an OpenAI-compatible response through this opt-in observer. Output bytes are unchanged.
import { StringDecoder } from 'node:string_decoder';
import { once } from 'node:events';
import { appendObservation, parseOptions } from '../../server/overseer/journal.js';
import { createCompletionObserver } from '../../server/overseer/completions.js';
try {
  const options = parseOptions(process.argv.slice(2));
  if (options.command.length) throw Error('Unexpected command');
  let warned = false;
  const observer = createCompletionObserver(options, event => {
    try { appendObservation(options.journal, event); }
    catch { if (!warned) process.stderr.write('[Spark Overseer] Observation unavailable; response is NOT protected.\n'); warned = true; }
  });
  const decoder = new StringDecoder('utf8');
  for await (const chunk of process.stdin) {
    observer.push(decoder.write(chunk));
    if (!process.stdout.write(chunk)) await once(process.stdout, 'drain');
  }
  observer.push(decoder.end());
  observer.end();
} catch {
  process.stderr.write('Usage: observe-completion.mjs --journal /absolute/events.ndjson [--model model-id] [--allow-host hostname]\n');
  process.exitCode = 2;
}
