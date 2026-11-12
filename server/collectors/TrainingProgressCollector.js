// Copyright 2026 Maxrio9. SPDX-License-Identifier: Apache-2.0
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { sshExec } from "./ssh.js";
import { normalizeProgressDocument } from "../training/schema.js";

const probeUrl = new URL("./trainingProgressProbe.py", import.meta.url);
const quote = (text) => `'${text.replaceAll("'", "'\\''")}'`;
export const progressLocationKey = (value) => createHash("sha256").update(value).digest("hex").slice(0, 24);

export async function runProgressProbe(unit, roots, execute = sshExec) {
  const source = await readFile(probeUrl, "utf8");
  const argument = JSON.stringify(roots);
  if (!unit.isLocal) return execute(unit, `python3 -I -S - ${quote(argument)}`, { input: source, timeoutMs: 8_000, maxBuffer: 256 * 1024 });
  return new Promise((resolve, reject) => {
    const child = execFile("python3", ["-I", "-S", "-", argument], {
      timeout: 8_000, killSignal: "SIGKILL", maxBuffer: 256 * 1024,
      env: { HOME: process.env.HOME, PATH: process.env.PATH },
    }, (error, stdout) => error ? reject(error) : resolve(stdout));
    child.stdin.on("error", () => {});
    child.stdin.end(source);
  });
}

/** One fixed JSON adapter, parameterized by the configured unit. No framework discovery. */
export class TrainingProgressCollector {
  constructor(unit, { runProbe = runProgressProbe } = {}) {
    this.unit = unit;
    this.runProbe = runProbe;
  }

  async collect(roots, now = Date.now) {
    if (!roots.length) return { records: [], truncated: false, partial: false };
    const output = await this.runProbe(this.unit, roots);
    if (typeof output !== "string" || Buffer.byteLength(output) > 256 * 1024) throw new Error("Invalid progress probe output");
    const measuredAt = typeof now === "function" ? now() : now;
    const result = JSON.parse(output);
    if (!result || !Array.isArray(result.files) || result.files.length !== roots.length || typeof result.truncated !== "boolean") {
      throw new Error("Invalid progress probe output");
    }
    const seen = new Set();
    let partial = false;
    const records = result.files.map((entry) => {
      if (!entry || !Number.isInteger(entry.index) || entry.index < 0 || entry.index >= roots.length || seen.has(entry.index)) {
        throw new Error("Invalid progress probe output");
      }
      seen.add(entry.index);
      const key = progressLocationKey(`${this.unit.id}\0${roots[entry.index]}`);
      try {
        if (entry.error) {
          if (entry.error !== "missing") partial = true;
          return { key, document: null };
        }
        if (typeof entry.content !== "string" || Buffer.byteLength(entry.content) > 64 * 1024) throw new Error();
        return { key, document: normalizeProgressDocument(JSON.parse(entry.content), measuredAt) };
      } catch {
        partial = true;
        return { key, document: null };
      }
    });
    return { records, truncated: result.truncated, partial };
  }
}
