/**
 * docker.js — Docker containers via the local docker CLI (no daemon socket API).
 *
 * Seam type: ContainerInfo[] (shared/types.ts).
 *   - `docker ps -a --format json`     → name, image, state, ports (fallback)
 *   - `docker stats --no-stream --format json` → memUsedMB / memLimitMB / cpuPercent
 *   - `docker inspect <name>`          → image digest, port mappings, started-at
 */
import { runShell, parseSizeToMB } from "./util.js";

/** "Names" can be "/name" or "a,b" (multiple names) — take the first. */
function normalizeName(raw) {
  if (!raw) return "";
  const first = String(raw).split(",")[0].trim();
  return first.replace(/^\/+/, "");
}

/** docker ps State → ContainerInfo.status enum. */
function normalizeStatus(raw) {
  const s = String(raw || "").toLowerCase();
  if (s === "running") return "running";
  if (s === "paused") return "paused";
  if (s === "exited") return "exited";
  return "stopped";
}

/** Parse docker ps "Ports" text ("0.0.0.0:8080->8080/tcp") to "8080:8080". */
function parsePortsString(raw) {
  if (!raw) return [];
  const out = [];
  for (const s of String(raw).split(",")) {
    const t = s.trim();
    if (!t) continue;
    const bound = t.match(/:(\d+)->(\d+)\/\w+$/);
    if (bound) {
      out.push(`${bound[1]}:${bound[2]}`);
      continue;
    }
    const exposed = t.match(/^(\d+)\/\w+$/);
    if (exposed) {
      out.push(exposed[1]);
      continue;
    }
    out.push(t);
  }
  return out;
}

/**
 * docker inspect for one container: image digest, ports, started-at.
 * @param {(cmd: string) => Promise<string>} exec
 * @param {string} name
 * @returns {Promise<{imageDigest:string|null, startedAt:string|null, ports:string[]} | null>}
 */
async function inspectContainer(exec, name) {
  try {
    const raw = await exec(`docker inspect "${name}" --format json 2>/dev/null`);
    let data = JSON.parse(raw);
    if (Array.isArray(data)) data = data[0];
    if (!data || typeof data !== "object") return null;

    /** @type {string[]} */
    const ports = [];
    const pb = data.HostConfig?.PortBindings;
    if (pb && typeof pb === "object") {
      for (const [containerPort, bindings] of Object.entries(pb)) {
        for (const b of Array.isArray(bindings) ? bindings : []) {
          if (b && b.HostPort) ports.push(`${b.HostPort}:${String(containerPort).split("/")[0]}`);
        }
      }
    }
    if (ports.length === 0 && data.Config?.ExposedPorts && typeof data.Config.ExposedPorts === "object") {
      ports.push(...Object.keys(data.Config.ExposedPorts).map((p) => String(p).split("/")[0]));
    }

    const state = data.State && typeof data.State === "object" ? data.State : {};
    return {
      imageDigest: typeof data.ImageID === "string" ? data.ImageID : null,
      startedAt:
        state.Status === "running" && typeof state.StartedAt === "string" ? state.StartedAt : null,
      ports,
    };
  } catch {
    return null;
  }
}

/**
 * Collect all containers (running + stopped).
 * @param {{ exec?: (cmd: string) => Promise<string>, now?: () => number }} [deps]
 * @returns {Promise<Array<{name:string, image:string, imageDigest:string|null, status:string, uptimeSeconds:number|null, ports:string[], memUsedMB:number|null, memLimitMB:number|null, cpuPercent:number|null}>>}
 */
export async function collectDocker({ exec = runShell, now = Date.now } = {}) {
  try {
    const psRaw = await exec("docker ps -a --format json 2>/dev/null");
    /** @type {Array<Record<string, unknown>>} */
    const rows = [];
    for (const line of psRaw.split("\n")) {
      if (!line.trim()) continue;
      try {
        rows.push(JSON.parse(line));
      } catch {
        /* skip unparseable line */
      }
    }
    if (rows.length === 0) return [];

    // docker stats: NDJSON on older docker, JSON array on docker >= 25.
    const statsMap = new Map();
    try {
      const statsRaw = await exec("docker stats --no-stream --format json 2>/dev/null");
      let parsedRows;
      try {
        const parsed = JSON.parse(statsRaw);
        parsedRows = Array.isArray(parsed) ? parsed : [parsed];
      } catch {
        parsedRows = statsRaw
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l));
      }
      for (const r of parsedRows) {
        if (r && typeof r === "object" && r.NAME) statsMap.set(normalizeName(r.NAME), r);
      }
    } catch {
      /* stats optional — live metrics stay null */
    }

    const result = [];
    for (const row of rows) {
      const name = normalizeName(row.Names ?? row.name ?? "");
      if (!name) continue;

      const info = await inspectContainer(exec, name);
      const st = statsMap.get(name);
      const status = normalizeStatus(row.State ?? row.Status ?? "");
      const ports = info && info.ports.length > 0 ? info.ports : parsePortsString(row.Ports);

      let uptimeSeconds = null;
      if (status === "running" && info?.startedAt) {
        const startMs = Date.parse(info.startedAt);
        if (Number.isFinite(startMs)) {
          uptimeSeconds = Math.max(0, Math.round((now() - startMs) / 1000));
        }
      }

      let memUsedMB = null;
      let memLimitMB = null;
      let cpuPercent = null;
      if (st) {
        const memParts = String(st["MEM USAGE"] ?? "").split("/");
        memUsedMB = parseSizeToMB(memParts[0]);
        const limit = parseSizeToMB(memParts[1] ?? "");
        memLimitMB = limit != null && limit > 0 ? limit : null;
        const cpu = parseFloat(String(st["CPU %"] ?? st["CPU%"] ?? "").replace(/%$/, ""));
        cpuPercent = Number.isFinite(cpu) ? Math.round(cpu * 100) / 100 : null;
      }

      result.push({
        name,
        image: String(row.Image ?? row.image ?? "unknown"),
        imageDigest: info?.imageDigest ?? null,
        status,
        uptimeSeconds,
        ports,
        memUsedMB,
        memLimitMB,
        cpuPercent,
      });
    }
    return result;
  } catch {
    return [];
  }
}
