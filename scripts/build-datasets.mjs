#!/usr/bin/env node
/**
 * Builds the Quality bench's fixed dataset samples from the public sources, through the Hugging
 * Face datasets-server rows API (JSON, no parquet tooling needed). Every output is a frozen,
 * seeded sample checked into server/collectors/data/; the bench never fetches at run time.
 *
 *   node scripts/build-datasets.mjs            # all three
 *   node scripts/build-datasets.mjs gsm8k      # one of: gsm8k, mmlupro, math500
 *
 *  - gsm8k-platinum-200.json: the bench's 200 GSM8K test items re-labelled with GSM8K-Platinum
 *    (madrylab/gsm8k-platinum, MIT), which revised or removed the mislabeled originals. Items
 *    Platinum removed are dropped; a changed reference is recorded as `was`.
 *  - mmlu-pro-300.json: a stratified seeded sample of TIGER-Lab/MMLU-Pro (MIT), 21 per category
 *    plus one more for the six largest categories: 300 ten-option questions.
 *  - math500.json: HuggingFaceH4/MATH-500 (the 500-problem test subset of Hendrycks MATH, MIT), whole.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { mulberry32 } from "../server/collectors/qualitySuite.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA = path.join(ROOT, "server/collectors/data");
const API = "https://datasets-server.huggingface.co/rows";

async function rows(dataset, config, split) {
  const out = [];
  for (let offset = 0; ; offset += 100) {
    const url = `${API}?dataset=${encodeURIComponent(dataset)}&config=${config}&split=${split}&offset=${offset}&length=100`;
    let res;
    for (let attempt = 0; attempt < 10; attempt++) {
      res = await fetch(url);
      if (res.ok) break;
      // The rows API rate-limits bulk reads (429): back off, honouring Retry-After when given.
      const retryAfter = Number(res.headers.get("retry-after")) || 0;
      await new Promise((r) => setTimeout(r, Math.max(retryAfter * 1000, 8000 * (attempt + 1))));
    }
    // Stay under the limit on long pulls.
    await new Promise((r) => setTimeout(r, 400));
    if (!res.ok) throw new Error(`${dataset} offset ${offset}: HTTP ${res.status}`);
    const json = await res.json();
    for (const r of json.rows) out.push(r.row);
    if (offset + 100 >= json.num_rows_total) break;
  }
  return out;
}

const norm = (s) => String(s).replace(/\s+/g, " ").replace(/[’‘]/g, "'").replace(/[“”]/g, '"').trim();
const finalNumber = (answer) => {
  const m = String(answer).match(/####\s*(-?[\d,]*\.?\d+)/);
  return m ? Number(m[1].replace(/,/g, "")) : null;
};

async function buildGsm8k() {
  const current = JSON.parse(readFileSync(path.join(DATA, "gsm8k-200.json"), "utf8"));
  const platinum = await rows("madrylab/gsm8k-platinum", "main", "test");
  const byQ = new Map(platinum.map((r) => [norm(r.question), r]));
  const out = [];
  const dropped = [];
  const changed = [];
  for (const it of current) {
    const p = byQ.get(norm(it.q));
    if (!p) {
      dropped.push(it.n);
      continue;
    }
    const a = finalNumber(p.answer);
    const row = { n: it.n, q: it.q, a, status: p.cleaning_status };
    if (a !== it.a) {
      row.was = it.a;
      changed.push([it.n, it.a, a]);
    }
    out.push(row);
  }
  writeFileSync(path.join(DATA, "gsm8k-platinum-200.json"), `${JSON.stringify(out)}\n`);
  console.log(`gsm8k-platinum: ${out.length} of ${current.length} kept; dropped ${dropped.join(", ") || "none"}; changed answers: ${changed.map(([n, a, b]) => `${n}: ${a}→${b}`).join(", ") || "none"}`);
  for (const n of [675, 782, 835, 951, 952, 1035]) {
    const row = out.find((r) => r.n === n);
    console.log(`  disputed ${n}: ${row ? `kept, answer ${row.a}${row.was != null ? ` (was ${row.was})` : ""}, ${row.status}` : "removed by Platinum"}`);
  }
}

async function buildMmluPro() {
  const all = await rows("TIGER-Lab/MMLU-Pro", "default", "test");
  const byCat = new Map();
  for (const r of all) {
    const list = byCat.get(r.category) || [];
    list.push(r);
    byCat.set(r.category, list);
  }
  const cats = [...byCat.keys()].sort();
  const sizes = cats.map((c) => [c, byCat.get(c).length]).sort((a, b) => b[1] - a[1]);
  const extra = new Set(sizes.slice(0, 6).map(([c]) => c));
  const rand = mulberry32(20261105);
  const out = [];
  for (const cat of cats) {
    const list = [...byCat.get(cat)].sort((a, b) => Number(a.question_id) - Number(b.question_id));
    const want = 21 + (extra.has(cat) ? 1 : 0);
    const picked = new Set();
    while (picked.size < Math.min(want, list.length)) picked.add(Math.floor(rand() * list.length));
    for (const i of [...picked].sort((a, b) => a - b)) {
      const r = list[i];
      const options = Array.isArray(r.options) ? r.options : JSON.parse(r.options);
      out.push({ n: Number(r.question_id), cat, q: r.question, o: options, a: r.answer, src: r.src });
    }
  }
  writeFileSync(path.join(DATA, "mmlu-pro-300.json"), `${JSON.stringify(out)}\n`);
  console.log(`mmlu-pro: ${out.length} items over ${cats.length} categories (${cats.join(", ")}); options per item ${Math.min(...out.map((r) => r.o.length))}–${Math.max(...out.map((r) => r.o.length))}`);
}

async function buildMath500() {
  const all = await rows("HuggingFaceH4/MATH-500", "default", "test");
  const out = all
    .map((r) => ({ id: r.unique_id, q: r.problem, a: r.answer, subject: r.subject, level: Number(r.level) }))
    .sort((a, b) => a.id.localeCompare(b.id));
  writeFileSync(path.join(DATA, "math500.json"), `${JSON.stringify(out)}\n`);
  const subjects = {};
  for (const r of out) subjects[r.subject] = (subjects[r.subject] || 0) + 1;
  console.log(`math500: ${out.length} items; subjects ${JSON.stringify(subjects)}; levels ${[...new Set(out.map((r) => r.level))].sort().join(",")}`);
}

const which = process.argv[2];
if (!which || which === "gsm8k") await buildGsm8k();
if (!which || which === "mmlupro") await buildMmluPro();
if (!which || which === "math500") await buildMath500();
