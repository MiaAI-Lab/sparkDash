import fs from "fs";
import { SPARKS_JSON_PATH, LLM_PORT } from "../config.js";
import { loadSecrets, saveSecrets } from "../secretsStore.js";
import { atomicWrite } from "../util/atomicWrite.js";
import { isValidSparkId } from "../validate.js";

/**
 * SparkRegistry — loads, persists, and emits change events for the Spark list.
 * Single source of truth for `sparks.json`.
 *
 * SSH passwords:
 *  - Never written to sparks.json
 *  - Never returned by public API helpers (hasPassword only)
 *  - Held in memory for SSH collectors
 *  - Encrypted at rest in config/sparks-secrets.json (survives Docker restart)
 */
export class SparkRegistry {
  constructor() {
    this._sparks = [];
    /** @type {Map<string, string>} sparkId -> password */
    this._passwords = new Map();
    this._listeners = new Set();
    this._load();
  }

  // ─── Accessors ──────────────────────────────────────────
  get sparks() {
    return this._sparks.map((s) => this._withPassword(s));
  }

  /** Public-safe list (no secrets). */
  get publicSparks() {
    return this._sparks.map((s) => this.toPublic(s));
  }

  get sparkIds() {
    return this._sparks.map((s) => s.id);
  }

  /** Find a Spark by ID (includes in-memory password if present). */
  getSpark(id) {
    const s = this._sparks.find((s) => s.id === id) || null;
    return s ? this._withPassword(s) : null;
  }

  /** Redact secrets for API responses. */
  toPublic(spark) {
    if (!spark) return spark;
    const ssh = { ...(spark.ssh || {}) };
    delete ssh.password;
    // Always expose whether a secret is available (for Edit UI after restart)
    if (ssh.auth === "pass" || this._passwords.has(spark.id)) {
      ssh.hasPassword = this._passwords.has(spark.id);
    }
    return { ...spark, ssh };
  }

  // ─── CRUD ───────────────────────────────────────────────
  /** Add a new Spark. Throws if ID already exists or is malformed. */
  addSpark(config) {
    if (!config.id) throw new Error("Spark config must have an 'id'");
    if (!isValidSparkId(config.id)) {
      throw new Error(
        "Invalid Spark id: allowed characters are a-z A-Z 0-9 . _ -, length 1–64, and reserved names are not allowed"
      );
    }
    if (this.getSpark(config.id)) throw new Error(`Spark ${config.id} already exists`);
    const spark = this._normalizeConfig(config);
    this._storePassword(spark.id, config?.ssh?.password);
    this._sparks.push(spark);
    this._save();
    this._emit("add", this._withPassword(spark));
    return this._withPassword(spark);
  }

  /**
   * Persist the last-seen MAC for the WoL NIC (enP7s7). No-op if unchanged.
   * Does not overwrite a user macAddress override.
   * @param {string} id
   * @param {string} mac
   * @returns {object | null} updated public spark, or null if unchanged / missing
   */
  noteDetectedMac(id, mac) {
    const idx = this._sparks.findIndex((s) => s.id === id);
    if (idx === -1) return null;
    const clean = String(mac || "")
      .trim()
      .toLowerCase();
    if (!/^([0-9a-f]{2}[:\-]){5}[0-9a-f]{2}$/.test(clean)) return null;
    const prev = this._sparks[idx];
    if (prev.detectedMacAddress === clean) return null;
    this._sparks[idx] = this._normalizeConfig({ ...prev, detectedMacAddress: clean });
    this._save();
    this._emit("update", this._withPassword(this._sparks[idx]));
    return this.toPublic(this._sparks[idx]);
  }

  /** Update an existing Spark by ID. Does not allow changing `id`. */
  updateSpark(id, updates) {
    const idx = this._sparks.findIndex((s) => s.id === id);
    if (idx === -1) throw new Error(`Spark ${id} not found`);

    // Client cannot set detectedMacAddress (auto from enP7s7 only)
    const { id: _ignoreId, detectedMacAddress: _ignoreDetected, ...safeUpdates } = updates || {};
    const prev = this._sparks[idx];

    // Merge ssh carefully so we don't drop auth fields
    let mergedSsh = prev.ssh;
    if (safeUpdates.ssh) {
      mergedSsh = { ...prev.ssh, ...safeUpdates.ssh };
      if (Object.prototype.hasOwnProperty.call(safeUpdates.ssh, "password")) {
        this._storePassword(id, safeUpdates.ssh.password);
      }
      delete mergedSsh.password;
    }

    const updated = {
      ...prev,
      ...safeUpdates,
      id, // never overwrite id
      ssh: mergedSsh,
    };
    this._sparks[idx] = this._normalizeConfig(updated);
    this._save();
    this._emit("update", this._withPassword(this._sparks[idx]));
    return this._withPassword(this._sparks[idx]);
  }

  /** Remove a Spark by ID. Returns removed Spark or null. */
  removeSpark(id) {
    const idx = this._sparks.findIndex((s) => s.id === id);
    if (idx === -1) return null;
    const removed = this._sparks.splice(idx, 1)[0];
    if (this._passwords.has(id)) {
      this._passwords.delete(id);
      this._persistSecrets();
    }
    this._save();
    this._emit("remove", removed);
    return this.toPublic(removed);
  }

  /**
   * Reorder Sparks. `orderedIds` is the full desired id sequence.
   * Unknown ids are ignored; any missing registered Sparks are appended.
   * @param {string[]} orderedIds
   * @returns {object[]} public sparks in new order
   */
  reorderSparks(orderedIds) {
    if (!Array.isArray(orderedIds)) throw new Error("order must be an array of spark ids");
    const byId = new Map(this._sparks.map((s) => [s.id, s]));
    const seen = new Set();
    const next = [];
    for (const id of orderedIds) {
      if (typeof id !== "string" || !byId.has(id) || seen.has(id)) continue;
      next.push(byId.get(id));
      seen.add(id);
    }
    for (const s of this._sparks) {
      if (!seen.has(s.id)) next.push(s);
    }
    this._sparks = next;
    this._save();
    this._emit("reorder", null);
    return this.publicSparks;
  }

  // ─── Events ─────────────────────────────────────────────
  /** Register a listener: fn(action, spark) where action is 'add'|'update'|'remove' */
  onChange(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  // ─── Persistence ────────────────────────────────────────
  _load() {
    // Load encrypted secrets first (survives restart)
    try {
      this._passwords = loadSecrets();
    } catch (err) {
      console.error("[SparkRegistry] secrets load failed:", err.message);
      this._passwords = new Map();
    }

    try {
      const raw = fs.readFileSync(SPARKS_JSON_PATH, "utf-8");
      const data = JSON.parse(raw);
      const loaded = data.sparks || [];
      this._sparks = [];
      let migratedSecrets = false;
      for (const s of loaded) {
        // Migrate: pull plaintext passwords into encrypted store, strip from disk
        if (s?.ssh?.password) {
          this._passwords.set(s.id, s.ssh.password);
          migratedSecrets = true;
          console.warn(
            `[SparkRegistry] Migrated password for ${s.id} from sparks.json into encrypted secrets store; ` +
              `rotate this credential if it was previously exposed.`
          );
        }
        this._sparks.push(this._normalizeConfig(s));
      }
      if (migratedSecrets || loaded.some((s) => s?.ssh?.password)) {
        this._persistSecrets();
        this._save(); // rewrite sparks.json without passwords
      }
    } catch (err) {
      if (err.code === "ENOENT") {
        this._sparks = [];
        this._save();
      } else {
        console.error("[SparkRegistry] Failed to load sparks.json:", err.message);
        this._sparks = [];
      }
    }
  }

  _save() {
    try {
      // Never write passwords to sparks.json
      const sparks = this._sparks.map((s) => {
        const ssh = { ...(s.ssh || {}) };
        delete ssh.password;
        delete ssh.hasPassword;
        return { ...s, ssh };
      });
      const data = { sparks };
      // Atomic write (tmp + rename) — a SIGKILL/power loss mid-write must not
      // truncate the registry and silently drop every Spark on next restart.
      // 0o644 keeps the registry readable so root/non-root container users share it.
      atomicWrite(SPARKS_JSON_PATH, JSON.stringify(data, null, 2) + "\n", 0o644);
    } catch (err) {
      console.error("[SparkRegistry] Failed to save sparks.json:", err.message);
    }
  }

  // ─── Internal ───────────────────────────────────────────
  _emit(action, spark) {
    for (const fn of this._listeners) {
      try {
        fn(action, spark);
      } catch (err) {
        console.error("[SparkRegistry] Listener error:", err);
      }
    }
  }

  /**
   * Store / clear password. Always persists to encrypted secrets file.
   * Host being offline does not matter — credentials are local.
   * @param {string} id
   * @param {string|null|undefined} password  null/undefined = no-op; "" = clear
   */
  _storePassword(id, password) {
    if (password == null) return;
    if (password === "") {
      if (this._passwords.has(id)) {
        this._passwords.delete(id);
        this._persistSecrets();
      }
      return;
    }
    this._passwords.set(id, String(password));
    this._persistSecrets();
  }

  /** Public helper: set password without other config changes (e.g. from Test / Edit). */
  setPassword(id, password) {
    if (!this._sparks.find((s) => s.id === id)) throw new Error(`Spark ${id} not found`);
    this._storePassword(id, password);
    return this.toPublic(this.getSpark(id));
  }

  hasPassword(id) {
    return this._passwords.has(id);
  }

  _persistSecrets() {
    try {
      saveSecrets(this._passwords);
    } catch (err) {
      console.error("[SparkRegistry] Failed to persist secrets:", err.message);
      throw err; // surface to API so the UI can show it
    }
  }

  _withPassword(spark) {
    if (!spark) return spark;
    const password = this._passwords.get(spark.id);
    if (!password) return { ...spark, ssh: { ...spark.ssh } };
    return {
      ...spark,
      ssh: { ...spark.ssh, password },
    };
  }

  _normalizeConfig(config) {
    const sshIn = config.ssh || {};
    const ssh = {
      host: sshIn.host || "",
      user: sshIn.user || "root",
      auth: sshIn.auth === "pass" ? "pass" : "key",
    };
    const llmPorts = this._normalizeLlmPorts(config.llmPorts ?? config.llmPort);
    const llmCluster = this._normalizeLlmCluster(config.llmCluster);
    // Never keep password on the persisted object
    return {
      id: config.id,
      name: config.name || config.id,
      lanIp: config.lanIp || "",
      cx7Ip: config.cx7Ip || null,
      /** Optional user override for Wake-on-LAN. Empty → use detectedMacAddress. */
      macAddress: config.macAddress || null,
      /** Last MAC seen on enP7s7 (auto; not set via public PATCH). */
      detectedMacAddress: config.detectedMacAddress || null,
      isLocal: Boolean(config.isLocal),
      ssh,
      llmPorts,
      llmCluster,
      /** When true, this Spark is an LLM worker — no local API card / probe. */
      workerNode: Boolean(config.workerNode),
      disabledDevices: Array.isArray(config.disabledDevices) ? config.disabledDevices : [],
      disabledInterfaces: Array.isArray(config.disabledInterfaces) ? config.disabledInterfaces : [],
      storagePollDisabled: Boolean(config.storagePollDisabled),
    };
  }

  /** Normalize optional distributed-LLM cluster membership metadata. */
  _normalizeLlmCluster(value) {
    if (!value || typeof value !== "object") return null;
    const role = value.role === "head" ? "head" : value.role === "worker" ? "worker" : null;
    const headPort = Number(value.headPort);
    const rank = Number(value.rank);
    const worldSize = Number(value.worldSize);
    if (
      !role ||
      typeof value.label !== "string" || !value.label.trim() ||
      typeof value.headSparkId !== "string" || !value.headSparkId.trim() ||
      !Number.isInteger(headPort) || headPort < 1 || headPort > 65535 ||
      !Number.isInteger(rank) || rank < 0 ||
      !Number.isInteger(worldSize) || worldSize < 1 || rank >= worldSize
    ) return null;
    return {
      label: value.label.trim(),
      role,
      headSparkId: value.headSparkId.trim(),
      headPort,
      rank,
      worldSize,
    };
  }

  /** Normalize LLM ports: accepts array or single value, validates 1–65535, deduplicates. */
  _normalizeLlmPorts(value) {
    if (Array.isArray(value)) {
      const ports = value
        .map((v) => (typeof v === "string" ? parseInt(v, 10) : Number(v)))
        .filter((n) => Number.isInteger(n) && n >= 1 && n <= 65535);
      // Deduplicate while preserving order
      const seen = new Set();
      const unique = [];
      for (const p of ports) {
        if (!seen.has(p)) {
          seen.add(p);
          unique.push(p);
        }
      }
      return unique.length > 0 ? unique : [LLM_PORT];
    }
    // Legacy single port value
    const n = typeof value === "string" ? parseInt(value, 10) : Number(value);
    if (Number.isInteger(n) && n >= 1 && n <= 65535) return [n];
    return [LLM_PORT];
  }
}
