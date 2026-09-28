/**
 * ModelRegistry — loads, validates, persists, and emits change events for the
 * model launcher cards (config/models.json).
 *
 * Cloned from SparkRegistry's CRUD template (atomicWrite + onChange) but the
 * security surface is different: these configs name directories and scripts
 * that the dashboard executes on the model's assigned Spark (over SSH; nsenter
 * only for a local Spark without SSH). Everything that reaches disk is
 * therefore passed through a strict allowlist here and nowhere else:
 *
 *  - `dir`        repo directory, resolved against MODEL_REPOS_BASE; the
 *                 absolute path must stay inside the base (no `..`, no
 *                 absolute escapes, no symlinked-out — the base itself is
 *                 operator-set env, only traversal is defended).
 *  - `sparkId`    the Spark whose machine runs the scripts: same id charset
 *                 as spark ids; existence is NOT checked here (the registry
 *                 stays decoupled from SparkRegistry) — job start resolves it
 *                 and fails with a clear error when the Spark is missing.
 *  - scripts      bare filenames matching /^[A-Za-z0-9._-]{1,64}\.sh$/; they
 *                 are invoked as `./<name>` inside the repo (cwd), never
 *                 interpolated into a shell pipeline.
 *  - container    `docker ps` name: docker's own charset, tightened to
 *                 [A-Za-z0-9._-]{1,128}.
 *  - port         integer 1–65535.
 *  - schedule     { enabled, weekday[], weekend[] } via shared modelSchedules.
 *
 * No secrets live here, so the file is plain JSON (0o644 like sparks.json).
 */
import fs from "fs";
import path from "path";
import { MODELS_JSON_PATH, MODEL_REPOS_BASE } from "../config.js";
import { atomicWrite } from "../util/atomicWrite.js";
import {
  normalizeModelSchedule,
  validateModelSchedule,
  scheduleIsUsable,
  scheduleWindows,
  findScheduleConflicts,
} from "../../src/shared/modelSchedules.js";

/** Model ids: same charset as spark ids (used in URLs and job keys). */
const MODEL_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
const RESERVED_IDS = new Set(["jobs", "config", "preview", "order"]);
const SCRIPT_RE = /^[A-Za-z0-9._-]{1,64}\.sh$/;
const CONTAINER_RE = /^[A-Za-z0-9._-]{1,128}$/;
const LABEL_MAX = 80;
const DESC_MAX = 240;

/**
 * Normalise a repo URL for the card's GitHub link. Optional convenience
 * metadata, so bad input yields null rather than an error (same policy as
 * apiPath) — the important part is that only an http(s) URL can ever reach the
 * browser as an href, which also covers scp-style git remotes.
 * @returns {string|null}
 */
export function normalizeRepoUrl(raw) {
  if (typeof raw !== "string") return null;
  let url = raw.trim();
  if (!url) return null;
  // git@github.com:owner/repo.git  ->  https://github.com/owner/repo
  const ssh = /^(?:ssh:\/\/)?git@([^:/]+)[:/](.+?)$/.exec(url);
  if (ssh) url = `https://${ssh[1]}/${ssh[2]}`;
  if (!/^https?:\/\//i.test(url)) return null;
  url = url.replace(/\.git$/i, "").replace(/\/+$/, "");
  return url.length <= 240 ? url : null;
}

export function isValidModelId(id) {
  return (
    typeof id === "string" &&
    MODEL_ID_RE.test(id) &&
    id !== "." &&
    id !== ".." &&
    !RESERVED_IDS.has(id)
  );
}

/**
 * Resolve a repo dir against the base and prove it stays inside.
 * Exported for tests. Returns the validated absolute path or null.
 * @param {string} dir value from the config (relative to base, or base-absolute)
 * @param {string} base MODEL_REPOS_BASE (absolute, host view)
 */
export function resolveRepoDir(dir, base) {
  if (typeof dir !== "string" || !dir.trim()) return null;
  const baseAbs = path.resolve(base);
  // Accept either a base-relative name ("GLM-5.3-…") or an absolute host path
  // that happens to start with the base; both normalize under `baseAbs`.
  const candidate = path.isAbsolute(dir) ? path.resolve(dir) : path.resolve(baseAbs, dir);
  const rel = path.relative(baseAbs, candidate);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  // Reject any traversal segments even if normalize ate them weirdly, plus
  // hidden files directly in base and path separators in the first segment.
  const segs = rel.split(path.sep);
  if (segs.some((s) => s === ".." || s.startsWith("."))) return null;
  return candidate;
}

/**
 * Validate + normalize one model config. Throws Error(message) on violation —
 * the API layer maps thrown messages to 400 responses.
 * @param {object} config
 * @param {string} [base] override for MODEL_REPOS_BASE (tests)
 */
export function validateModelConfig(config, base = MODEL_REPOS_BASE) {
  if (!config || typeof config !== "object") throw new Error("Model config must be an object");
  if (!isValidModelId(config.id)) {
    throw new Error(
      "Invalid model id: allowed characters are a-z A-Z 0-9 . _ -, length 1–64, reserved names not allowed"
    );
  }
  const errors = [];

  const name =
    typeof config.name === "string" && config.name.trim()
      ? config.name.trim().slice(0, LABEL_MAX)
      : config.id;

  let dir = null;
  if (typeof config.dir !== "string" || !config.dir.trim()) {
    errors.push("dir is required (repo directory under the models base)");
  } else {
    dir = resolveRepoDir(config.dir.trim(), base);
    if (!dir) errors.push(`dir must resolve inside ${path.resolve(base)} (no '..', no hidden segments)`);
  }

  const scripts = {};
  for (const key of ["startScript", "stopScript", "restartScript", "logsScript"]) {
    const raw = config[key];
    if (typeof raw === "string" && SCRIPT_RE.test(raw.trim())) {
      scripts[key] = raw.trim();
    } else if (raw != null && raw !== "") {
      errors.push(`${key} must be a bare script name matching [A-Za-z0-9._-]{1,64}.sh`);
    } else {
      scripts[key] = null;
    }
  }
  if (!scripts.startScript) errors.push("startScript is required (e.g. start.sh)");
  if (!scripts.stopScript) errors.push("stopScript is required (e.g. stop.sh)");

  let container = null;
  if (config.container != null && config.container !== "") {
    if (typeof config.container === "string" && CONTAINER_RE.test(config.container.trim())) {
      container = config.container.trim();
    } else {
      errors.push("container must match [A-Za-z0-9._-]{1,128}");
    }
  }

  let port = null;
  if (config.port != null && config.port !== "") {
    const n = typeof config.port === "string" ? parseInt(config.port, 10) : Number(config.port);
    if (Number.isInteger(n) && n >= 1 && n <= 65535) port = n;
    else errors.push("port must be an integer 1–65535");
  }

  if (!container && !port) {
    errors.push("at least one of container / port is required for liveness probing");
  }

  // Card position in the Overview list. Optional on input (a new model lands
  // at the end); _normalizeOrder() re-stamps 1..n on every save, so the file
  // always reads in display order and the field can be hand-edited freely.
  let position = null;
  if (config.position != null && config.position !== "") {
    // Number(), not parseInt(): "1.5" must be rejected, not silently floored to 1.
    const n = Number(config.position);
    if (Number.isInteger(n) && n >= 1) position = n;
    else errors.push("position must be an integer ≥ 1");
  }

  const scheduleCheck = validateModelSchedule(config.schedule);
  if (!scheduleCheck.ok) errors.push(...scheduleCheck.errors);

  // Optional fixed args for start — strict allowlist of flag-shaped tokens so
  // this can never become a shell-injection channel. Empty = bare ./start.sh.
  let startArgs = [];
  if (Array.isArray(config.startArgs) && config.startArgs.length) {
    if (config.startArgs.length > 4) errors.push("startArgs may hold at most 4 arguments");
    for (const a of config.startArgs) {
      if (typeof a !== "string" || !/^-{1,2}[A-Za-z0-9][A-Za-z0-9._=-]{0,63}$/.test(a)) {
        errors.push(`startArgs entries must be single flag tokens (got ${JSON.stringify(a)})`);
        break;
      }
    }
    startArgs = config.startArgs.filter(
      (a) => typeof a === "string" && /^-{1,2}[A-Za-z0-9][A-Za-z0-9._=-]{0,63}$/.test(a)
    );
  }

  // The Spark where this model's scripts live and run (over SSH). Optional at
  // rest — a card can be created before the fleet is wired — but a job (and a
  // probe pass) refuses to run without it: resolveRunTarget names the missing
  // assignment in the error the operator sees.
  let sparkId = null;
  if (config.sparkId != null && config.sparkId !== "") {
    if (typeof config.sparkId === "string" && MODEL_ID_RE.test(config.sparkId.trim())) {
      sparkId = config.sparkId.trim();
    } else {
      errors.push("sparkId must be a spark id matching [A-Za-z0-9._-]{1,64}");
    }
  }

  if (errors.length) throw new Error(errors.join("; "));

  const description =
    typeof config.description === "string" && config.description.trim()
      ? config.description.trim().slice(0, DESC_MAX)
      : null;

  return {
    id: config.id,
    name,
    dir,
    sparkId,
    startScript: scripts.startScript,
    stopScript: scripts.stopScript,
    restartScript: scripts.restartScript,
    logsScript: scripts.logsScript,
    startArgs,
    container,
    port,
    position,
    description,
    /** Optional deep-link the card can offer (e.g. the model's OpenAI base). */
    apiPath: typeof config.apiPath === "string" && config.apiPath.startsWith("/")
      ? config.apiPath.slice(0, 120)
      : null,
    /** GitHub/browse URL for the kit — validated to https; auto-detected from
     *  `git remote get-url origin` by the launcher, editable via the API. */
    repoUrl: normalizeRepoUrl(config.repoUrl),
    schedule: scheduleCheck.schedule,
    schedulerEligible: scheduleIsUsable(scheduleCheck.schedule),
  };
}

export class ModelRegistry {
  /**
   * @param {string} [filePath] registry JSON path (tests override)
   * @param {string} [base] repos base dir (tests override)
   */
  constructor(filePath = MODELS_JSON_PATH, base = MODEL_REPOS_BASE) {
    this.filePath = filePath;
    this.base = base;
    /** @type {object[]} */
    this._models = [];
    /** @type {Set<(action: string, model: object|null) => void>} */
    this._listeners = new Set();
    this._load();
  }

  // ─── Accessors ──────────────────────────────────────────
  get models() {
    return this._models.map((m) => ({ ...m }));
  }

  get modelIds() {
    return this._models.map((m) => m.id);
  }

  getModel(id) {
    const m = this._models.find((m) => m.id === id) || null;
    return m ? { ...m } : null;
  }

  // ─── CRUD ───────────────────────────────────────────────
  addModel(config) {
    if (this.getModel(config?.id)) throw new Error(`Model ${config?.id} already exists`);
    const model = validateModelConfig(config, this.base);
    this._assertNoConflicts(model);
    this._models.push(model);
    this._normalizeOrder();
    this._save();
    this._emit("add", model);
    return { ...model };
  }

  /** Update by id; `id` itself is immutable. */
  updateModel(id, updates) {
    const idx = this._models.findIndex((m) => m.id === id);
    if (idx === -1) throw new Error(`Model ${id} not found`);
    const prev = this._models[idx];
    const merged = validateModelConfig(
      { ...prev, ...(updates || {}), id },
      this.base
    );
    this._assertNoConflicts(merged);
    this._models[idx] = merged;
    // A changed `position` re-sorts the list; unchanged positions just get
    // re-stamped 1..n, which also repairs a hand-edited file with gaps/dupes.
    this._normalizeOrder();
    this._save();
    this._emit("update", merged);
    return { ...merged };
  }

  removeModel(id) {
    const idx = this._models.findIndex((m) => m.id === id);
    if (idx === -1) return null;
    const [removed] = this._models.splice(idx, 1);
    this._normalizeOrder();
    this._save();
    this._emit("remove", removed);
    return removed;
  }

  /**
   * Replace the schedule block for a model (used by the schedule dialog and
   * the API). Validates through the same path as full edits.
   */
  setSchedule(id, schedule) {
    return this.updateModel(id, { schedule });
  }

  // ─── Ordering ───────────────────────────────────────────
  /**
   * Sort the list by `position` (missing = end) and re-stamp 1..n, so the
   * array order, the stored numbers and the UI always agree. Called before
   * every save; safe to call any time.
   */
  _normalizeOrder() {
    this._models = this._models
      .map((m, i) => ({ m, i }))
      .sort((a, b) => {
        const pa = Number.isInteger(a.m.position) ? a.m.position : Number.POSITIVE_INFINITY;
        const pb = Number.isInteger(b.m.position) ? b.m.position : Number.POSITIVE_INFINITY;
        return pa !== pb ? pa - pb : a.i - b.i;
      })
      .map(({ m }, i) => {
        m.position = i + 1;
        return m;
      });
  }

  /**
   * Stamp 1..n by the CURRENT array order without sorting. moveModel/setOrder
   * have already put the array where the user wants it; re-sorting by the old
   * `position` values there would undo the move.
   */
  _renumberInPlace() {
    this._models.forEach((m, i) => {
      m.position = i + 1;
    });
  }

  /**
   * Nudge a model one slot up (-1) or down (+1) in the card list and return
   * the renumbered list. This is what the ↑/↓ buttons call.
   */
  moveModel(id, delta) {
    this._normalizeOrder();
    const idx = this._models.findIndex((m) => m.id === id);
    if (idx === -1) throw new Error(`Model ${id} not found`);
    const step = Number(delta) < 0 ? -1 : 1;
    const target = idx + step;
    if (target < 0 || target >= this._models.length) return this.models;
    const [moved] = this._models.splice(idx, 1);
    this._models.splice(target, 0, moved);
    this._renumberInPlace();
    this._save();
    this._emit("order", this.getModel(id));
    return this.models;
  }

  /**
   * Apply a full ordering by id list (drag-and-drop / hand-edited config).
   * Unknown ids are ignored, omitted ones keep their relative order at the end.
   */
  setOrder(ids) {
    if (!Array.isArray(ids)) throw new Error("order must be an array of model ids");
    const byId = new Map(this._models.map((m) => [m.id, m]));
    const next = [];
    for (const id of ids) {
      const m = byId.get(id);
      if (m && !next.includes(m)) {
        next.push(m);
        byId.delete(id);
      }
    }
    // Anything not named in the list keeps its previous relative order.
    for (const m of this._models) if (byId.has(m.id)) next.push(m);
    this._models = next;
    this._renumberInPlace();
    this._save();
    this._emit("order", null);
    return this.models;
  }

  /**
   * Two enabled schedules must not claim the same minute, or the scheduler
   * would have two targets for one tick. Weekday windows only ever compete
   * with weekday windows and weekend with weekend — the scheduler evaluates
   * exactly one dayType per instant — so the entries stay day-scoped instead
   * of being flattened (a weekend all-day window must not clash with a
   * weekday shift on another model). Checked against the other models only —
   * self-overlap is caught inside validateModelConfig.
   * @param {object} model a validated model record
   */
  _assertNoConflicts(model) {
    if (!model.schedule?.enabled) return;
    const entries = [];
    const push = (m) => {
      if (!m.schedule?.enabled) return;
      entries.push({
        id: m.id,
        name: m.name,
        weekday: scheduleWindows(m.schedule, "weekday"),
        weekend: scheduleWindows(m.schedule, "weekend"),
      });
    };
    push(model);
    for (const m of this._models) if (m.id !== model.id) push(m);
    const conflicts = findScheduleConflicts(entries);
    if (conflicts.length) {
      const e = new Error(conflicts.join(" "));
      e.status = 409;
      throw e;
    }
  }

  // ─── Events ─────────────────────────────────────────────
  /** Register a listener: fn(action, model) */
  onChange(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  // ─── Persistence ────────────────────────────────────────
  _load() {
    let raw;
    try {
      raw = fs.readFileSync(this.filePath, "utf-8");
    } catch (err) {
      if (err.code === "ENOENT") {
        this._models = [];
        this._save();
        return;
      }
      console.error("[ModelRegistry] Failed to load models.json:", err.message);
      this._models = [];
      return;
    }
    try {
      const data = JSON.parse(raw);
      const list = Array.isArray(data?.models) ? data.models : [];
      this._models = [];
      for (const m of list) {
        try {
          this._models.push(validateModelConfig(m, this.base));
        } catch (err) {
          // One bad entry (e.g. a repo moved on disk) must not hide the others.
          console.warn(`[ModelRegistry] Skipping invalid model ${m?.id}:`, err.message);
        }
      }
      // Respect `position` even if the array itself is out of order (hand-edit).
      this._normalizeOrder();
    } catch (err) {
      console.error("[ModelRegistry] Failed to parse models.json:", err.message);
      this._models = [];
    }
  }

  _save() {
    try {
      atomicWrite(
        this.filePath,
        JSON.stringify({ models: this._models }, null, 2) + "\n",
        0o644
      );
    } catch (err) {
      console.error("[ModelRegistry] Failed to save models.json:", err.message);
    }
  }

  _emit(action, model) {
    for (const fn of this._listeners) {
      try {
        fn(action, model);
      } catch (err) {
        console.error("[ModelRegistry] Listener error:", err);
      }
    }
  }
}
