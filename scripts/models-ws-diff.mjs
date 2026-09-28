/**
 * One-off dev probe: capture several `models` snapshot blocks over WS, keep
 * every distinct one, and print a field-level diff between distinct blocks so
 * a churn can be attributed to a field instead of guessed at. Dev tool, safe
 * to delete.
 */
import WebSocket from "ws";

const url = process.argv[2] || "ws://localhost:5555/ws";
const ws = new WebSocket(url);
const blocks = [];
let max = 8;

/** Flatten nested objects into "a.b[0].c" → primitive paths for diffing. */
function flat(obj, prefix = "", out = {}) {
  if (obj === null || typeof obj !== "object") {
    out[prefix] = typeof obj === "string" && obj.length > 60 ? obj.slice(0, 60) + "…" : obj;
    return out;
  }
  if (Array.isArray(obj)) {
    obj.forEach((v, i) => flat(v, `${prefix}[${i}]`, out));
    return out;
  }
  for (const [k, v] of Object.entries(obj)) flat(v, prefix ? `${prefix}.${k}` : k, out);
  return out;
}

function diff(a, b) {
  const fa = flat(a);
  const fb = flat(b);
  const keys = new Set([...Object.keys(fa), ...Object.keys(fb)]);
  const out = [];
  for (const k of keys) {
    if (JSON.stringify(fa[k]) !== JSON.stringify(fb[k])) {
      out.push(`  ${k}: ${JSON.stringify(fa[k])} -> ${JSON.stringify(fb[k])}`);
    }
  }
  return out;
}

ws.on("message", (d) => {
  const m = JSON.parse(d.toString());
  if (m.type !== "snapshot" || !m.models) return;
  blocks.push(m.models);
  if (blocks.length < max) return;

  const s0 = JSON.stringify(blocks[0]);
  const distinct = [s0];
  for (const b of blocks.slice(1)) {
    const s = JSON.stringify(b);
    if (!distinct.includes(s)) distinct.push(s);
  }
  console.log(`samples: ${blocks.length}, distinct blocks: ${distinct.length}`);
  if (distinct.length === 1) {
    console.log("STABLE — no field changes across samples");
  } else {
    console.log(`field-level diff, block #1 vs #2:\n${diff(JSON.parse(distinct[0]), JSON.parse(distinct[1])).join("\n")}`);
  }
  ws.close();
  process.exit(0);
});

ws.on("error", (e) => {
  console.log("ws error:", e.message);
  process.exit(1);
});
setTimeout(() => {
  console.log(`timeout after ${blocks.length} snapshots`);
  process.exit(2);
}, 30000);
