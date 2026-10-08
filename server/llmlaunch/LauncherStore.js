import fs from "fs";
import crypto from "crypto";
import { atomicWrite } from "../util/atomicWrite.js";
import { MAX_LAUNCHERS_PER_SPARK, isValidLauncherId, normalizeLauncherInput, slugify } from "./validate.js";

/**
 * Per-Spark list of user-registered LLM launchers, persisted to
 * config/llm-launchers.json. Holds only names, directories and script names.
 * No secrets live here, so the file is a plain 0644 document.
 */
export class LauncherStore {
  constructor({ file }) {
    this.file = file;
    /** @type {Record<string, object[]>} */
    this.data = {};
    this._load();
  }

  _load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, "utf8"));
      const src = parsed && typeof parsed === "object" ? parsed.launchers : null;
      if (src && typeof src === "object") {
        for (const [sparkId, list] of Object.entries(src)) {
          if (!Array.isArray(list)) continue;
          this.data[sparkId] = list.filter((l) => l && isValidLauncherId(l.id) && normalizeLauncherInput(l).ok);
        }
      }
    } catch {
      this.data = {};
    }
  }

  _save() {
    atomicWrite(this.file, JSON.stringify({ version: 1, launchers: this.data }, null, 2) + "\n", 0o644);
  }

  list(sparkId) {
    return (this.data[sparkId] ?? []).map((l) => ({ ...l }));
  }

  get(sparkId, launcherId) {
    const l = (this.data[sparkId] ?? []).find((x) => x.id === launcherId);
    return l ? { ...l } : null;
  }

  /** @returns {{ ok: true, launcher: object } | { ok: false, error: string }} */
  add(sparkId, input) {
    const norm = normalizeLauncherInput(input);
    if (!norm.ok) return norm;
    const list = this.data[sparkId] ?? [];
    if (list.length >= MAX_LAUNCHERS_PER_SPARK) {
      return { ok: false, error: `At most ${MAX_LAUNCHERS_PER_SPARK} models per Spark` };
    }
    const base = slugify(norm.value.name);
    let id = base;
    while (list.some((l) => l.id === id)) id = `${base}-${crypto.randomBytes(2).toString("hex")}`;
    const launcher = { id, ...norm.value, createdAt: Date.now() };
    this.data[sparkId] = [...list, launcher];
    this._save();
    return { ok: true, launcher: { ...launcher } };
  }

  update(sparkId, launcherId, input) {
    const list = this.data[sparkId] ?? [];
    const idx = list.findIndex((l) => l.id === launcherId);
    if (idx < 0) return { ok: false, error: "Model not found", notFound: true };
    const norm = normalizeLauncherInput({ ...list[idx], ...input });
    if (!norm.ok) return norm;
    const next = { ...list[idx], ...norm.value };
    this.data[sparkId] = list.map((l, i) => (i === idx ? next : l));
    this._save();
    return { ok: true, launcher: { ...next } };
  }

  remove(sparkId, launcherId) {
    const list = this.data[sparkId] ?? [];
    if (!list.some((l) => l.id === launcherId)) return false;
    this.data[sparkId] = list.filter((l) => l.id !== launcherId);
    if (this.data[sparkId].length === 0) delete this.data[sparkId];
    this._save();
    return true;
  }

  removeSpark(sparkId) {
    if (!(sparkId in this.data)) return;
    delete this.data[sparkId];
    this._save();
  }
}
