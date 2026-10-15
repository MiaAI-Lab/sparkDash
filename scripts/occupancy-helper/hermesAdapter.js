import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

/**
 * Read-only Hermes session metadata. Does not launch hermes-acp: that list
 * path backfills cwd into the database. sessions.json wins; state.db is a
 * mode=ro fallback when the JSON store is absent.
 */
export function loadHermes({
  stateDir,
  readFile = (file) => fs.readFileSync(file, "utf8"),
  readDb,
} = {}) {
  const dir = stateDir ? path.resolve(stateDir) : "";
  if (!dir) {
    return { coverage: "unavailable", stale: false, error: "HERMES_STATE_DIR is not set", rows: [] };
  }
  if (!fs.existsSync(dir)) {
    return { coverage: "unavailable", stale: false, error: "Hermes state dir is missing", rows: [] };
  }
  const jsonRows = readSessionsJson(dir, readFile);
  if (jsonRows.error) {
    return { coverage: "unavailable", stale: false, error: jsonRows.error, rows: [] };
  }
  if (jsonRows.found) {
    return { coverage: "supported", stale: false, error: null, rows: jsonRows.rows };
  }
  const dbPath = path.join(dir, "state.db");
  let dbExists = false;
  try {
    dbExists = fs.existsSync(dbPath);
  } catch {
    dbExists = false;
  }
  if (!dbExists) {
    return { coverage: "supported", stale: false, error: null, rows: [] };
  }
  const reader = readDb || readHermesDb;
  try {
    const rows = reader(dbPath);
    if (!Array.isArray(rows)) {
      return { coverage: "partial", stale: false, error: "state.db has no readable sessions table", rows: [] };
    }
    return { coverage: rows.length ? "supported" : "partial", stale: false, error: rows.length ? null : "state.db has no readable sessions table", rows };
  } catch (err) {
    return { coverage: "partial", stale: false, error: err.message || "state.db could not be read", rows: [] };
  }
}

export function readSessionsJson(dir, readFile) {
  const files = [path.join(dir, "sessions.json")];
  try {
    const profiles = fs.readdirSync(path.join(dir, "profiles"), { withFileTypes: true });
    for (const entry of profiles) {
      if (entry.isDirectory() && !entry.name.startsWith(".")) {
        files.push(path.join(dir, "profiles", entry.name, "sessions.json"));
      }
    }
  } catch {
    /* no profiles directory */
  }
  const rows = [];
  let found = false;
  for (const file of files) {
    let text;
    try {
      text = readFile(file);
    } catch (err) {
      if (err.code === "ENOENT") continue;
      return { found: false, missing: false, error: "Hermes sessions.json is unreadable", rows: [] };
    }
    found = true;
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { found: true, missing: false, error: "Hermes sessions.json is corrupt", rows: [] };
    }
    const profile = readProfile(path.dirname(file), readFile);
    for (const session of sessionList(parsed)) {
      const row = mapHermesSession(session, profile);
      if (row) rows.push(row);
    }
  }
  return { found, missing: !found, error: null, rows };
}

function sessionList(parsed) {
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === "object") {
    if (Array.isArray(parsed.sessions)) return parsed.sessions;
    return Object.values(parsed).filter((item) => item && typeof item === "object");
  }
  return [];
}

export function mapHermesSession(session, profile = {}) {
  if (!session || typeof session !== "object") return null;
  const sessionId = firstString(session, ["id", "session_id", "sessionId"]);
  const title = firstString(session, ["title", "name", "display_name", "slug"]) || sessionId.slice(0, 8);
  if (!sessionId && !title) return null;
  const origin = nativeOrigin(session, profile);
  const running = session.running === true || ["running", "generating", "in_progress"].includes(String(session.status || ""));
  const updated = session.updated_at || session.updatedAt || session.last_used_at || session.lastUsedAt || "";
  return {
    harness: "hermes",
    sessionId: sessionId || title,
    title,
    cwd: typeof session.cwd === "string" ? session.cwd : "",
    updatedAt: typeof updated === "number" ? new Date(updated).toISOString() : String(updated || ""),
    activity: running ? "generating" : "unknown",
    activityProvenance: running ? "native" : "none",
    origin: origin ? { host: origin.host, port: origin.port } : null,
    originProvenance: origin ? "native" : "none",
    agent: firstString(session, ["agent", "profile"]) || "",
  };
}

function firstString(obj, keys) {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return "";
}

function nativeOrigin(session, profile) {
  for (const raw of [session.billing_base_url, session.base_url, session.model?.base_url, profile.base_url]) {
    const origin = parseOrigin(raw);
    if (origin) return origin;
  }
  return null;
}

function readProfile(dir, readFile) {
  for (const name of ["config.json", "profile.json"]) {
    try {
      const parsed = JSON.parse(readFile(path.join(dir, name)));
      const base = parsed?.model?.base_url || parsed?.base_url;
      if (typeof base === "string") return { base_url: base };
    } catch {
      /* optional */
    }
  }
  return {};
}

function parseOrigin(raw) {
  if (typeof raw !== "string" || !raw.trim()) return null;
  try {
    const parsed = new URL(raw.trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    const port = parsed.port ? Number(parsed.port) : parsed.protocol === "https:" ? 443 : 80;
    if (!parsed.hostname || !Number.isInteger(port)) return null;
    return { host: parsed.hostname, port };
  } catch {
    return null;
  }
}

/** Fixed read-only query. The path is a local file, never SQL from the dashboard. */
export function readHermesDb(dbPath) {
  const script = `
import json, sqlite3, sys
path = sys.argv[1]
con = sqlite3.connect("file:%s?mode=ro" % path.replace("?", "%3F"), uri=True)
con.row_factory = sqlite3.Row
tables = [row[0] for row in con.execute("SELECT name FROM sqlite_master WHERE type='table'")]
wanted = next((name for name in tables if name.lower() in {"sessions", "session"}), None)
if not wanted:
    print(json.dumps({"rows": None, "reason": "no sessions table"}))
    raise SystemExit(0)
cols = [row[1] for row in con.execute(f"PRAGMA table_info({wanted})")]
lower = {col.lower(): col for col in cols}
def col(*names):
    for name in names:
        if name in lower:
            return lower[name]
    return None
fields = {
    "id": col("id", "session_id", "sessionid"),
    "title": col("title", "name"),
    "updated": col("updated_at", "updatedat", "last_used_at"),
    "cwd": col("cwd"),
    "base": col("base_url", "billing_base_url"),
    "status": col("status"),
    "running": col("running"),
}
if not fields["id"]:
    print(json.dumps({"rows": None, "reason": "no id column"}))
    raise SystemExit(0)
selected = [(key, name) for key, name in fields.items() if name]
query = "SELECT " + ", ".join(name for _key, name in selected) + f" FROM {wanted} LIMIT 500"
out = []
for record in con.execute(query):
    item = {key: record[name] for key, name in selected}
    out.append(item)
print(json.dumps({"rows": out}))
`;
  const result = spawnSync("python3", ["-c", script, dbPath], { encoding: "utf8", timeout: 8_000 });
  if (result.error || result.status !== 0) {
    throw new Error("state.db could not be read");
  }
  const parsed = JSON.parse(result.stdout || "{}");
  if (!Array.isArray(parsed.rows)) return null;
  return parsed.rows.map((item) =>
    mapHermesSession({
      id: item.id,
      title: item.title,
      updated_at: item.updated,
      cwd: item.cwd,
      base_url: item.base,
      status: item.status,
      running: item.running === 1 || item.running === true,
    })
  ).filter(Boolean);
}
