import { randomUUID } from 'node:crypto';
import { createPiFileWriter } from './writer.js';

/**
 * Pi occupancy extension. It publishes a small, content-free metadata file per
 * session so a sparkDash occupancy helper can list the session on the LLM card
 * whose endpoint the session is actually calling. It never reads prompts,
 * responses, tool output or credentials.
 *
 * @typedef {{provider: string, model: string, baseUrl: string | null}} Selection
 * @typedef {Selection & {api: string}} Candidate
 * @typedef {'requesting' | 'receiving' | 'tools' | 'idle' | 'unknown'} Phase
 * @typedef {object} PiRecord
 * @property {1} schemaVersion
 * @property {string} publisherId
 * @property {number} sequence
 * @property {string} sessionId
 * @property {string} title
 * @property {string} cwd
 * @property {Selection | null} selection
 * @property {Selection | null} requestDestination
 * @property {'none' | 'provider-matched'} destinationEvidence
 * @property {Phase} phase
 * @property {boolean} requestOpen
 * @property {string} updatedAt
 * @property {number | null} lastDeltaAt
 */

const DELTAS = new Set(['text_delta', 'thinking_delta', 'toolcall_delta']);

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
}
function text(value, max) {
  return typeof value === 'string' ? value.slice(0, max).replace(/[\x00-\x1f\x7f]/g, '').trim() : '';
}
function id(value, max = 200) {
  return typeof value === 'string' && value.length <= max && !/[\x00-\x1f\x7f]/.test(value) ? value.trim() : '';
}
/**
 * A destination is an absolute http(s) URL with no credentials, query or
 * fragment. The trailing slash is dropped so one endpoint has one spelling.
 * The dashboard decides whether that endpoint is one of its cards.
 */
function baseUrl(value) {
  if (typeof value !== 'string' || value.length > 1024) return null;
  try {
    const u = new URL(value);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (u.username || u.password || u.search || u.hash) return null;
    return `${u.origin}${u.pathname.replace(/\/$/, '')}`;
  } catch { return null; }
}
function model(value) {
  const v = object(value);
  if (!v) return null;
  const provider = id(v.provider), name = id(v.model), api = id(v.api);
  return provider && name ? { provider, model: name, api, baseUrl: baseUrl(v.baseUrl) } : null;
}
function publicModel(value) {
  return value ? { provider: value.provider, model: value.model, baseUrl: value.baseUrl } : null;
}
function same(a, b) {
  return Boolean(a && b && a.provider === b.provider && a.model === b.model && a.api && a.api === b.api && a.baseUrl === b.baseUrl);
}

/**
 * Pure metadata state machine. Its caller supplies safe fields, never raw SDK
 * events.
 *
 * @param {{now?: () => number, publish: (record: PiRecord | null) => unknown, publisherId?: string, initialSequence?: number}} options
 */
export function createPiObserver({ now = Date.now, publish, publisherId = randomUUID(), initialSequence = 0 }) {
  let row = null;
  let sequence = initialSequence;
  let current = null;
  let candidate = null;
  let blocked = false;
  let phase = 'idle';
  const tools = new Set();

  function snapshot() {
    return row ? {
      ...row,
      phase: tools.size ? 'tools' : phase,
      selection: row.selection ? { ...row.selection } : null,
      requestDestination: row.requestDestination ? { ...row.requestDestination } : null,
    } : null;
  }
  function notify(meaningful = true) {
    if (row) {
      if (meaningful) row.updatedAt = new Date(now()).toISOString();
      row.sequence = ++sequence;
    }
    try {
      const result = publish(snapshot());
      if (result instanceof Promise) void result.catch(() => {});
    } catch { /* No telemetry failure may escape into a Pi turn. */ }
  }
  function revoke() {
    if (!row) return;
    row.requestDestination = null;
    row.destinationEvidence = 'none';
    row.lastDeltaAt = null;
  }
  function observe(kind, meta = {}) {
    try {
      if (kind === 'session_start') {
        const session = object(meta.session);
        const sessionId = session ? id(session.id, 100) : '';
        tools.clear(); blocked = false; candidate = null; phase = 'idle';
        current = model(meta.selection);
        row = sessionId ? {
          schemaVersion: 1, publisherId, sequence,
          sessionId, title: text(session.title, 200), cwd: text(session.cwd, 500),
          selection: publicModel(current), requestDestination: null, destinationEvidence: 'none',
          phase, requestOpen: false, updatedAt: new Date(now()).toISOString(), lastDeltaAt: null,
        } : null;
        notify(); return;
      }
      if (!row) return;
      if (kind === 'session_shutdown') {
        row = null; current = null; candidate = null; tools.clear(); blocked = false;
        notify(false); return;
      }
      if (kind === 'heartbeat') { notify(false); return; }
      if (kind === 'session_info_changed') {
        const s = object(meta.session);
        if (s && id(s.id, 100) === row.sessionId) {
          row.title = text(s.title, 200); row.cwd = text(s.cwd, 500); notify();
        } else {
          row = null; current = null; candidate = null; tools.clear(); blocked = false;
          notify(false);
        }
        return;
      }
      if (kind === 'model_select') {
        blocked ||= row.requestOpen;
        revoke(); current = model(meta.selection); row.selection = publicModel(current);
        candidate = null; row.requestOpen = false; phase = 'unknown'; notify(); return;
      }
      if (kind === 'before_provider_request') {
        blocked ||= row.requestOpen;
        revoke(); current = model(meta.selection); candidate = current;
        row.selection = publicModel(current); row.requestOpen = true; phase = 'requesting';
        notify(); return;
      }
      if (kind === 'provider_stream_event') {
        if (!row.requestOpen) return;
        const selected = model(meta.selection);
        const dispatched = { provider: id(meta.provider), model: id(meta.model), api: id(meta.api) };
        if (blocked || !same(candidate, selected) || dispatched.provider !== candidate?.provider || dispatched.model !== candidate?.model || !dispatched.api || dispatched.api !== candidate?.api) {
          blocked = true; revoke(); phase = 'unknown';
        } else {
          row.requestDestination = publicModel(candidate);
          row.destinationEvidence = 'provider-matched'; phase = 'receiving';
        }
        current = selected; row.selection = publicModel(current); notify(); return;
      }
      if (kind === 'message_update') {
        if (!row.requestOpen || blocked || row.destinationEvidence !== 'provider-matched') return;
        if (typeof meta.tag !== 'string' || !DELTAS.has(meta.tag)) return;
        row.lastDeltaAt = now(); phase = 'receiving'; notify(); return;
      }
      if (kind === 'after_provider_response') {
        if (typeof meta.status === 'number' && meta.status >= 400) {
          revoke(); blocked = true; row.requestOpen = false; phase = 'unknown'; notify();
        }
        return;
      }
      if (kind === 'message_end') {
        if (meta.messageRole !== 'assistant') return;
        row.requestOpen = false; row.lastDeltaAt = null; phase = 'unknown'; notify(); return;
      }
      if (kind === 'tool_execution_start') {
        const call = id(meta.toolCallId);
        if (call && (tools.has(call) || tools.size < 128)) tools.add(call);
        else { blocked = true; revoke(); phase = 'unknown'; }
        row.lastDeltaAt = null; notify(); return;
      }
      if (kind === 'tool_execution_end') {
        const call = id(meta.toolCallId);
        if (call) tools.delete(call);
        notify(); return;
      }
      if (kind === 'agent_settled') {
        tools.clear(); blocked = false; candidate = null;
        row.requestOpen = false; row.lastDeltaAt = null; phase = 'idle'; notify(); return;
      }
      if (kind === 'observer_error') {
        revoke(); row.requestOpen = false; blocked = true; phase = 'unknown'; notify();
      }
      // agent_end is deliberately not final idle: retries/continuations follow it.
    } catch {
      if (row) {
        revoke(); row.requestOpen = false; blocked = true; phase = 'unknown';
        notify();
      }
    }
  }
  return { observe, snapshot };
}

/** @typedef {{write: (record: PiRecord | null) => unknown}} Writer */
/** @typedef {{publisherId: string, sequence: number, pending: {writer: Writer, record: PiRecord | null} | null, writing: Promise<void> | null, owner: object | null}} PiPublisherState */

/** Shared I/O contains owned metadata only, never a Pi API/context/event object. */
export function createPiPublisherState() {
  return { publisherId: randomUUID(), sequence: 0, pending: null, writing: null, owner: null };
}
function globalPublisher() {
  const key = Symbol.for('sparkdash.pi.publisher.v1');
  const registry = globalThis;
  return registry[key] ??= createPiPublisherState();
}
function schedule(fn, ms, repeat = false) {
  const timer = repeat ? setInterval(fn, ms) : setTimeout(fn, ms);
  timer.unref?.();
  return () => { if (repeat) clearInterval(timer); else clearTimeout(timer); };
}
function enqueue(shared, job) {
  shared.pending = job; // One latest snapshot, not one queued promise per token.
  if (shared.writing) return;
  shared.writing = Promise.resolve().then(async () => {
    while (shared.pending) {
      const next = shared.pending; shared.pending = null;
      try { await next.writer.write(next.record); } catch { /* File age fails closed downstream. */ }
    }
  }).finally(() => {
    shared.writing = null;
    if (shared.pending) enqueue(shared, shared.pending);
  });
}
function makeRuntime(shared, writer, now, clock, shutdownMs) {
  let latest;
  let cancelCoalescing = null;
  let cancelHeartbeat = null;
  const runtime = {
    active: true,
    core: createPiObserver({ now, publisherId: shared.publisherId, initialSequence: shared.sequence, publish: record => {
      if (!runtime.active) return;
      if (record) shared.sequence = record.sequence;
      latest = record;
      if (!cancelCoalescing) cancelCoalescing = clock(drain, 250);
    } }),
    async flush() { drain(); await shared.writing; },
    async stop() {
      if (!runtime.active) return;
      runtime.active = false;
      cancelCoalescing?.(); cancelCoalescing = null;
      cancelHeartbeat?.(); cancelHeartbeat = null;
      latest = undefined;
      runtime.core.observe('session_shutdown');
      if (shared.owner === runtime) shared.owner = null;
      enqueue(shared, { writer, record: null });
      let cancel = () => {};
      const timeout = new Promise(resolve => { cancel = clock(resolve, Math.min(2000, Math.max(0, shutdownMs))); });
      try { await Promise.race([shared.writing, timeout]); } finally { cancel(); }
    },
  };
  function drain() {
    cancelCoalescing?.(); cancelCoalescing = null;
    if (!runtime.active || latest === undefined) return;
    const record = latest; latest = undefined;
    enqueue(shared, { writer, record });
  }
  cancelHeartbeat = clock(() => { if (runtime.active) runtime.core.observe('heartbeat'); }, 5000, true);
  return runtime;
}
function sessionMetadata(ctx) {
  return { id: ctx.sessionManager.getSessionId(), title: ctx.sessionManager.getSessionName(), cwd: ctx.cwd };
}
function modelMetadata(ctx) {
  const m = ctx.model;
  return m ? { provider: m.provider, model: m.id, api: m.api, baseUrl: m.baseUrl } : null;
}

/**
 * Registration is inert. All SDK access happens synchronously in a fresh hook.
 *
 * @param {{on: (name: string, handler: (...args: any[]) => unknown) => unknown}} pi
 * @param {{shared?: PiPublisherState, writer?: Writer, now?: () => number, schedule?: (fn: () => void, ms: number, repeat?: boolean) => () => void, shutdownMs?: number, runtimeDir?: string}} [opts]
 */
export function registerPiObserver(pi, opts = {}) {
  let current = null;
  let shared = opts.shared;
  function start(ctx) {
    try {
      shared ??= globalPublisher();
      void shared.owner?.stop();
      const writer = opts.writer ?? createPiFileWriter({ runtimeDir: opts.runtimeDir, publisherId: shared.publisherId });
      current = makeRuntime(shared, writer, opts.now ?? Date.now, opts.schedule ?? schedule, opts.shutdownMs ?? 2000);
      shared.owner = current;
      current.core.observe('session_start', { session: sessionMetadata(ctx), selection: modelMetadata(ctx) });
    } catch { void current?.stop(); }
  }
  function record(kind, fields = () => ({})) {
    if (!current?.active) return;
    try { current.core.observe(kind, fields()); }
    catch { current.core.observe('observer_error'); }
  }
  pi.on('session_start', (_event, ctx) => { start(ctx); });
  pi.on('session_info_changed', (_event, ctx) => { record('session_info_changed', () => ({ session: sessionMetadata(ctx) })); });
  pi.on('model_select', (_event, ctx) => { record('model_select', () => ({ selection: modelMetadata(ctx) })); });
  pi.on('before_provider_request', (_event, ctx) => { record('before_provider_request', () => ({ selection: modelMetadata(ctx) })); });
  pi.on('provider_stream_event', (event, ctx) => { record('provider_stream_event', () => ({ selection: modelMetadata(ctx), provider: event.provider, model: event.model, api: event.api })); });
  pi.on('after_provider_response', event => { record('after_provider_response', () => ({ status: event.status })); });
  pi.on('message_update', event => { record('message_update', () => ({ tag: event.assistantMessageEvent.type })); });
  pi.on('message_end', event => { record('message_end', () => ({ messageRole: event.message.role })); });
  pi.on('tool_execution_start', event => { record('tool_execution_start', () => ({ toolCallId: event.toolCallId })); });
  pi.on('tool_execution_end', event => { record('tool_execution_end', () => ({ toolCallId: event.toolCallId })); });
  pi.on('agent_end', () => { record('agent_end'); });
  pi.on('agent_settled', () => { record('agent_settled'); });
  pi.on('session_shutdown', () => current?.stop());
  return { snapshot: () => current?.core.snapshot() ?? null, flush: async () => { await current?.flush(); }, stop: async () => { await current?.stop(); } };
}

/** @param {{on: (name: string, handler: (...args: any[]) => unknown) => unknown}} pi */
export default function piObserver(pi) {
  registerPiObserver(pi);
}
