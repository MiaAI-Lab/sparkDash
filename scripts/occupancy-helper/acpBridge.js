import { spawn } from "node:child_process";

const ALLOWED_METHODS = new Set(["initialize", "session/list"]);
const PAGE_CAP = 8;
const ROW_CAP = 500;
const BYTE_CAP = 2_000_000;
const TIME_CAP_MS = 20_000;
const RPC_TIMEOUT_MS = 14_000;

/**
 * One persistent ACP metadata bridge. initialize + session/list only.
 * A failed refresh keeps the last good rows and marks them stale.
 * Stop bumps the generation so a late response cannot publish.
 */
export function createAcpBridge({
  harness,
  argv,
  openProcess = defaultOpenProcess,
  now = Date.now,
  pageCap = PAGE_CAP,
  rowCap = ROW_CAP,
  byteCap = BYTE_CAP,
  timeCapMs = TIME_CAP_MS,
} = {}) {
  let generation = 0;
  let child = null;
  let buffer = "";
  let nextId = 1;
  let initialized = false;
  let blocked = null;
  let refreshing = null;
  /** @type {Map<number, { resolve: Function, reject: Function }>} */
  const waiters = new Map();
  const sent = [];
  let cache = emptyCache();

  function current() {
    return { ...cache, rows: cache.rows.map((row) => ({ ...row })), sent: [...sent] };
  }

  async function refresh() {
    if (refreshing) return refreshing;
    const gen = generation;
    refreshing = run(gen).finally(() => {
      refreshing = null;
    });
    return refreshing;
  }

  async function run(gen) {
    if (blocked === "unsupported") return current();
    if (!Array.isArray(argv) || argv.length === 0 || typeof argv[0] !== "string" || !argv[0]) {
      publish(gen, { ...emptyCache(), coverage: "unavailable", error: "ACP command is not configured" });
      return current();
    }
    try {
      await ensureReady(gen);
      const listed = await listAll(gen);
      publish(gen, {
        coverage: "supported",
        stale: false,
        error: null,
        observedAt: now(),
        rows: listed,
      });
    } catch (err) {
      if (gen !== generation) return current();
      if (err?.code === "unsupported") {
        blocked = "unsupported";
        closeChild();
        publish(gen, {
          coverage: "unsupported",
          stale: false,
          error: err.message,
          observedAt: now(),
          rows: [],
        });
        return current();
      }
      const had = cache.observedAt != null && cache.rows.length > 0;
      publish(gen, {
        coverage: had ? "partial" : cache.coverage === "supported" ? "partial" : "unavailable",
        stale: had || cache.coverage === "supported",
        error: err.message || "ACP refresh failed",
        observedAt: cache.observedAt,
        rows: had || cache.coverage === "supported" ? cache.rows : [],
      });
    }
    return current();
  }

  function publish(gen, next) {
    if (gen !== generation) return;
    cache = next;
  }

  async function ensureReady(gen) {
    if (child && initialized && !child.killed) return;
    await startChild(gen);
    const init = await rpc(gen, "initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: "sparkdash-occupancy-helper", version: "1" },
    });
    const caps = init?.agentCapabilities?.sessionCapabilities;
    if (!caps || !Object.prototype.hasOwnProperty.call(caps, "list")) {
      const err = new Error(`${harness} does not advertise session/list`);
      err.code = "unsupported";
      throw err;
    }
    initialized = true;
  }

  async function listAll(gen) {
    const rows = [];
    const cursors = new Set();
    let cursor = null;
    let pages = 0;
    let bytes = 0;
    const started = now();
    do {
      if (pages >= pageCap || rows.length >= rowCap || now() - started > timeCapMs) break;
      const params = {};
      if (cursor) params.cursor = cursor;
      const result = await rpc(gen, "session/list", params);
      const batch = Array.isArray(result?.sessions) ? result.sessions : [];
      bytes += JSON.stringify(batch).length;
      if (bytes > byteCap) break;
      for (const row of batch) {
        if (rows.length >= rowCap) break;
        rows.push(mapRow(row));
      }
      pages += 1;
      const next = typeof result?.nextCursor === "string" && result.nextCursor ? result.nextCursor : "";
      if (!next || batch.length === 0) {
        cursor = null;
      } else if (cursors.has(next)) {
        throw new Error("repeated cursor");
      } else {
        cursors.add(next);
        cursor = next;
      }
    } while (cursor);
    return rows.filter(Boolean);
  }

  function mapRow(row) {
    if (!row || typeof row !== "object") return null;
    const sessionId = typeof row.sessionId === "string" ? row.sessionId.trim() : "";
    if (!sessionId) return null;
    return {
      harness,
      sessionId,
      title: typeof row.title === "string" ? row.title : "",
      cwd: typeof row.cwd === "string" ? row.cwd : "",
      updatedAt: typeof row.updatedAt === "string" ? row.updatedAt : "",
      activity: "unknown",
      activityProvenance: "none",
      origin: null,
      originProvenance: "none",
    };
  }

  function startChild(gen) {
    closeChild();
    initialized = false;
    buffer = "";
    const proc = openProcess(argv);
    if (gen !== generation) {
      killProcess(proc);
      throw new Error("bridge stopped");
    }
    child = proc;
    child.stdout?.on?.("data", (chunk) => onStdout(chunk));
    child.stderr?.on?.("data", () => {
      /* drained; startup output can contain paths and is not logged */
    });
    child.once?.("exit", () => {
      if (child === proc) {
        child = null;
        initialized = false;
        rejectWaiters(new Error("ACP bridge exited"));
      }
    });
    return Promise.resolve();
  }

  function onStdout(chunk) {
    buffer += chunk.toString("utf8");
    let nl = buffer.indexOf("\n");
    while (nl >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line) dispatch(line);
      nl = buffer.indexOf("\n");
    }
  }

  function dispatch(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg && typeof msg.method === "string" && Object.prototype.hasOwnProperty.call(msg, "id")) {
      refuse(msg);
      return;
    }
    if (msg && Object.prototype.hasOwnProperty.call(msg, "id") && !msg.method) {
      const waiter = waiters.get(msg.id);
      if (!waiter) return;
      waiters.delete(msg.id);
      if (msg.error) waiter.reject(new Error(msg.error.message || "ACP error"));
      else waiter.resolve(msg.result || {});
    }
  }

  function refuse(msg) {
    try {
      child?.stdin?.write?.(
        `${JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Read-only metadata client" } })}\n`
      );
    } catch {
      /* bridge is going away */
    }
  }

  function rpc(gen, method, params) {
    if (!ALLOWED_METHODS.has(method)) {
      return Promise.reject(new Error(`ACP method not allowed: ${method}`));
    }
    if (gen !== generation || !child) return Promise.reject(new Error("bridge stopped"));
    const id = nextId++;
    sent.push(method);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(id);
        reject(new Error(`${method} timed out`));
      }, RPC_TIMEOUT_MS);
      waiters.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
      try {
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      } catch (err) {
        clearTimeout(timer);
        waiters.delete(id);
        reject(err);
      }
    });
  }

  function rejectWaiters(err) {
    for (const waiter of waiters.values()) waiter.reject(err);
    waiters.clear();
  }

  function closeChild() {
    const proc = child;
    child = null;
    initialized = false;
    rejectWaiters(new Error("bridge stopped"));
    killProcess(proc);
  }

  function stop() {
    generation += 1;
    blocked = null;
    closeChild();
    cache = emptyCache();
  }

  return { refresh, stop, current, sent: () => [...sent] };
}

function emptyCache() {
  return { coverage: "unavailable", stale: false, error: null, observedAt: null, rows: [] };
}

function killProcess(proc) {
  if (!proc || proc.killed) return;
  try {
    if (proc.pid) process.kill(-proc.pid, "SIGTERM");
    else proc.kill?.("SIGTERM");
  } catch {
    try {
      proc.kill?.("SIGTERM");
    } catch {
      /* already gone */
    }
  }
}

export function defaultOpenProcess(argv) {
  return spawn(argv[0], argv.slice(1), { stdio: ["pipe", "pipe", "pipe"], detached: true });
}

/** Operator env: a JSON array, or a whitespace-separated argv. No shell. */
export function argvFromEnv(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  if (text.startsWith("[")) {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed) || parsed.some((part) => typeof part !== "string")) {
      throw new Error("ACP command must be an array of strings");
    }
    return parsed;
  }
  if (/[\0\r\n]/.test(text)) throw new Error("ACP command is invalid");
  return text.split(/\s+/);
}
