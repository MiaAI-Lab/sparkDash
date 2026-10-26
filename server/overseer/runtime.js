import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { safeEvent, safeModel, SIGNALS } from './signals.js';
import { MAX_JOURNAL_BYTES } from './journal.js';

const TAIL_BYTES = 512 * 1024;
const MAX_EVENTS = 2000;
export async function readJournal(file) {
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw Error('Not a regular journal');
    const size = Math.min(stat.size, TAIL_BYTES);
    const data = Buffer.alloc(size);
    const { bytesRead } = await handle.read(data, 0, size, stat.size - size);
    let text = data.subarray(0, bytesRead).toString('utf8');
    if (stat.size > size) text = text.slice(text.indexOf('\n') + 1);
    const lines = text.split('\n');
    const pending = lines.pop() !== '';
    return { lines: lines.slice(-1000), truncated: stat.size > size || lines.length > 1000, full: stat.size >= MAX_JOURNAL_BYTES - 4096, pending };
  } finally { await handle.close(); }
}

/** One shared runtime for every registry unit. No SSH, sudo, model calls or HTTP ingestion. */
export function createOverseerRuntime({ enabled = false, configFile, getUnits = () => [], pollMs = 5000, readTimeoutMs = 2000, read = readJournal, now = Date.now } = {}) {
  let timer, pending, closed = false, started = false, configError = null, checkedAt = null;
  let sources = [], coverage = [];
  const events = new Map();
  const inflightReads = new Map();
  async function boundedRead(file) {
    if (!inflightReads.has(file)) inflightReads.set(file, Promise.resolve().then(() => read(file)).finally(() => inflightReads.delete(file)));
    let timeout;
    try {
      return await Promise.race([inflightReads.get(file), new Promise((_, reject) => { timeout = setTimeout(() => reject(Error('Journal deadline')), readTimeoutMs); })]);
    } finally { clearTimeout(timeout); }
  }
  async function configure() {
    if (!enabled) return;
    try {
      if (!configFile || !path.isAbsolute(configFile)) throw Error('Missing configuration');
      const handle = await fs.open(configFile, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      let config;
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > 65536) throw Error('Invalid configuration file');
        const buffer = Buffer.alloc(stat.size);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        config = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
      } finally { await handle.close(); }
      if (!Array.isArray(config.sources) || config.sources.length > 16) throw Error('Invalid sources');
      const seen = new Set();
      sources = config.sources.map(source => {
        if (!/^[a-z0-9._-]{1,64}$/i.test(source.sparkId ?? '') || seen.has(source.sparkId) || !path.isAbsolute(source.journal ?? '')) throw Error('Invalid source');
        seen.add(source.sparkId);
        return { sparkId: source.sparkId, journal: source.journal };
      });
    } catch { configError = 'Configuration unavailable or invalid'; sources = []; }
  }
  async function doPoll() {
    if (!enabled || closed || configError) return;
    const units = getUnits();
    coverage = await Promise.all(sources.map(async source => {
      if (!units.some(unit => unit.id === source.sparkId)) return { sparkId: source.sparkId, state: 'unknown-unit', count: null };
      try {
        const journal = await boundedRead(source.journal);
        if (closed) return { sparkId: source.sparkId, state: 'unavailable', count: null };
        let invalid = 0, count = 0;
        for (const line of journal.lines) {
          if (!line.trim()) continue;
          try {
            const value = JSON.parse(line);
            if (Number.isFinite(value.timestamp) && value.timestamp < now() - 86400000) continue;
            const event = safeEvent(value, source.sparkId, now());
            if (!event) { invalid++; continue; }
            count++;
            events.set(event.id, event);
          } catch { invalid++; }
        }
        return { sparkId: source.sparkId, state: invalid || journal.full || journal.pending ? 'partial' : 'readable', count, invalid,
          truncated: journal.truncated, pending: journal.pending, capacityWarning: journal.full };
      } catch { return { sparkId: source.sparkId, state: 'unavailable', count: null }; }
    }));
    checkedAt = now();
    for (const [id, event] of events) if (event.timestamp < now() - 86400000) events.delete(id);
    if (events.size > MAX_EVENTS) {
      const keep = [...events.values()].sort((a, b) => b.timestamp - a.timestamp).slice(0, MAX_EVENTS);
      events.clear();
      for (const event of keep) events.set(event.id, event);
    }
  }
  function poll() {
    if (!pending) pending = doPoll().catch(() => { configError = 'Collector unavailable'; checkedAt = null; }).finally(() => { pending = null; });
    return pending;
  }
  function snapshot() {
    const units = getUnits().map(unit => ({ id: unit.id, name: unit.name ?? unit.id,
      models: (Array.isArray(unit.metrics?.llm) ? unit.metrics.llm : []).slice(0, 16).filter(model => model?.available && typeof model.modelId === 'string').map(model => safeModel(model.modelId)).filter(model => model !== 'unspecified') }));
    const state = !enabled ? 'disabled' : configError ? 'unavailable' : !sources.length ? 'unconfigured' : !checkedAt ? 'starting' : coverage.some(source => source.state !== 'readable') ? 'partial' : 'observing';
    const list = [...events.values()].sort((a, b) => b.timestamp - a.timestamp || a.id.localeCompare(b.id));
    return { enabled, state, checkedAt, pollMs, mode: 'observe-only', modelTokens: 0, sources: coverage, units, signals: SIGNALS,
      events: list, limits: { events: MAX_EVENTS, hours: 24, tailBytes: TAIL_BYTES, linesPerSource: 1000 },
      summary: !enabled || !checkedAt || !coverage.some(source => source.count !== null) ? null : {
        actions: list.length, flagged: list.filter(event => event.signals.length).length,
        high: list.filter(event => event.severity === 'high').length,
      }, error: configError };
  }
  return {
    async start() {
      if (started || closed) return;
      started = true;
      await configure();
      await poll();
      if (enabled && !closed && !configError && sources.length) { timer = setInterval(() => { void poll(); }, pollMs); timer.unref(); }
    },
    poll,
    snapshot,
    async close() { closed = true; clearInterval(timer); await pending; },
    register(app) {
      app.get('/api/overseer', (req, res) => {
        res.set('Cache-Control', 'no-store');
        if (Object.keys(req.query ?? {}).length) return res.status(400).json({ error: 'Overseer does not accept source paths or query options' });
        res.json(snapshot());
      });
    },
  };
}
