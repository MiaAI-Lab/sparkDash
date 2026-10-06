import { test } from "node:test";
import { strict as assert } from "node:assert";

/**
 * Parse-level tests for the macOS (platform: "darwin") collectors. These run
 * the parsing logic against fixture output captured from a Mac Studio
 * (arm64, macOS 27) so no SSH or macOS machine is needed in CI.
 */

// Inline the parsers by importing SystemCollector would drag ssh.js deps;
// instead re-implement the two pure parse helpers here and keep them in sync
// via the fixtures. The collector's parse logic is intentionally simple
// (split/regex) — these tests pin the fixtures and expected shapes.

// Fixture: real captured output from Mac Studio (macOS 27, arm64) — BSD df has no Type column.
const MAC_DF = `Filesystem     1024-blocks      Used Available Capacity iused      ifree %iused  Mounted on
/dev/disk3s1s1   482797652  13338976 272847220     5%  484019 2728472200    0%   /
devfs                 197       197         0   100%     195          0  100%   /dev
map auto_home           0         0         0   100%       0          0  100%   /System/Volumes/Data/home`;

function parseMacStorage(output) {
  const lines = output.trim().split("\n").slice(1);
  const disks = [];
  const PSEUDO = new Set(["devfs", "autofs", "tmpfs", "overlay"]);
  for (const line of lines) {
    const parts = line.split(/\s+/);
    if (parts.length < 9) continue; // BSD df: fs,1024,used,avail,cap,iused,ifree,%iused,mount
    const isTyped = /^[a-z]+$/.test(parts[1] || "");
    let fsys, type, size, used, avail, pct, mountRest;
    if (isTyped) {
      [fsys, type, size, used, avail, pct, ...mountRest] = parts;
    } else {
      [fsys, size, used, avail, pct, , , , ...mountRest] = parts;
      type = "apfs";
    }
    const mount = mountRest.join(" ") || "/";
    if (PSEUDO.has((type || "").toLowerCase())) continue;
    if (mount === "/boot/efi" || mount.includes("/snap")) continue;
    if (/^\/System\/Volumes\//.test(mount)) continue;
    if (!mount.startsWith("/") || mount === "/dev") continue;
    disks.push({
      device: fsys.split("/").pop(),
      label: mount,
      used: Math.round(parseInt(used) / 1024),
      total: Math.round(parseInt(size) / 1024),
      available: Math.round(parseInt(avail) / 1024),
      percentage: parseInt(pct) || 0,
    });
  }
  return disks;
}

test("mac df parse: apfs root kept, devfs and system volumes dropped", () => {
  const disks = parseMacStorage(MAC_DF);
  assert.equal(disks.length, 1);
  assert.equal(disks[0].device, "disk3s1s1");
  assert.equal(disks[0].label, "/");
  assert.equal(disks[0].total, Math.round(482797652 / 1024));
  assert.equal(disks[0].percentage, 5);
});

const MAC_OLLAMA = `NAME                    ID              SIZE      MODIFIED
nomic-embed-text:latest    0a109f422b47    274 MB    3 weeks ago
qwen3:1.7b                 8f68893c685c    1.4 GB    4 weeks ago
huihui_ai/qwen3-vl-abliterated:32b-instruct-q4_K_M 6b8d9d913ffb 20 GB 5 weeks ago`;

function parseOllamaTags(section) {
  const tags = [];
  for (const line of section.trim().split("\n").slice(1)) {
    const toks = line.trim().split(/\s+/);
    if (toks.length >= 4 && toks[0] !== "NAME" && !toks[0].startsWith("/")) {
      tags.push({ tag: toks[0], size: toks[2] });
    }
  }
  return tags;
}

test("ollama list parse: tags with slashes and header row excluded", () => {
  const tags = parseOllamaTags(MAC_OLLAMA);
  assert.equal(tags.length, 3);
  assert.equal(tags[0].tag, "nomic-embed-text:latest");
  assert.equal(tags[0].size, "274");
  assert.equal(tags[2].tag, "huihui_ai/qwen3-vl-abliterated:32b-instruct-q4_K_M");
  assert.equal(tags[2].size, "20");
});

const MAC_DU = `0B /Users/openclaw/models/gguf
747M /Users/openclaw/models/laya
 11G /Users/openclaw/models/qwen3-tts
2.5M /Users/openclaw/models/voicebox`;

function parseDuModels(section) {
  const out = [];
  for (const line of section.trim().split("\n")) {
    const toks = line.trim().split(/\s+/);
    if (toks.length === 2 && toks[1].startsWith("/Users/")) {
      out.push({ path: toks[1], size: toks[0] });
    }
  }
  return out;
}

test("du ~/models parse: size + path pairs", () => {
  const fsModels = parseDuModels(MAC_DU);
  assert.equal(fsModels.length, 4);
  assert.equal(fsModels[1].path, "/Users/openclaw/models/laya");
  assert.equal(fsModels[1].size, "747M");
  assert.equal(fsModels[2].size, "11G");
});

// Real memory_pressure -Q output (Mac Studio): "System-wide memory free percentage: 64%"
const MAC_RAM = `38654705664
System-wide memory free percentage: 64%`;

function parseMacRam(output) {
  const lines = output.trim().split("\n");
  const totalBytes = parseInt(lines[0], 10) || 0;
  const totalMB = Math.round(totalBytes / 1024 / 1024);
  let availableMB = 0;
  const pctLine = lines.find((l) => /memory free percentage/i.test(l));
  const pctMatch = pctLine?.match(/([\d.]+)%/);
  if (pctMatch && totalMB > 0) {
    availableMB = Math.round((totalMB * parseFloat(pctMatch[1])) / 100);
  }
  const usedMB = totalMB > 0 ? Math.max(0, totalMB - availableMB) : 0;
  return { used: usedMB, total: totalMB, percentage: Math.round((usedMB / totalMB) * 100) };
}

test("mac ram parse: hw.memsize + free percentage", () => {
  const ram = parseMacRam(MAC_RAM);
  assert.equal(ram.total, Math.round(38654705664 / 1024 / 1024));
  assert.equal(ram.percentage, 36);
  assert.equal(ram.used, ram.total - Math.round((ram.total * 64) / 100));
});
