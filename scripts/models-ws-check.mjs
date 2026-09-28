/**
 * Dev-only check: is the `models` half of the WS snapshot byte-stable across
 * several broadcast ticks? A Date.now()-derived field anywhere in this block
 * would make it differ every tick and thrash index.js's diff cache.
 *
 * Run against a live server: node scripts/models-ws-check.mjs [wsUrl]
 * Exits non-zero if the block changes while nothing is happening.
 */
import WebSocket from "ws";

const url = process.argv[2] || "ws://localhost:5555/ws";
const ws = new WebSocket(url);
const seen = [];

ws.on("message", (d) => {
  const m = JSON.parse(d.toString());
  if (m.type !== "snapshot" || !m.models) return;
  seen.push(JSON.stringify(m.models));
  if (seen.length >= 4) {
    const unique = new Set(seen).size;
    console.log(`ticks sampled: ${seen.length}`);
    console.log(`distinct models blocks: ${unique}`);
    console.log("model statuses:", JSON.parse(seen[0]).models.map((x) => `${x.id}=${x.status.running}`).join(" "));
    console.log("scheduler:", JSON.stringify(JSON.parse(seen[0]).scheduler));
    console.log(unique === 1 ? "PASS — byte-stable while idle" : "FAIL — payload churns every tick");
    ws.close();
    process.exit(unique === 1 ? 0 : 1);
  }
});

ws.on("error", (e) => {
  console.log("ws error:", e.message);
  process.exit(1);
});
setTimeout(() => {
  console.log(`timeout after ${seen.length} snapshots`);
  process.exit(seen.length ? 1 : 2);
}, 15000);
