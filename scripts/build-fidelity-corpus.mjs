#!/usr/bin/env node
/**
 * Builds the Quality bench's fidelity corpus (server/collectors/data/fidelity-corpus.json): a fixed
 * set of documents the model scores by prompt log-probabilities (no generation). Everything in it
 * comes from this MIT-licensed repository or from the bench's own seeded generators, so the corpus
 * is licence-clean and reproducible. The file is a frozen snapshot: the bench never reads the live
 * sources, and the corpus hash is recorded on every run. Re-run this script only to make a new
 * corpus version (bump CORPUS_VERSION; runs across versions do not pair).
 *
 *   node scripts/build-fidelity-corpus.mjs
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { mulberry32 } from "../server/collectors/qualitySuite.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "server/collectors/data/fidelity-corpus.json");
const CORPUS_VERSION = 1;

const read = (rel) => readFileSync(path.join(ROOT, rel), "utf8");
const sha = (s) => createHash("sha256").update(s).digest("hex");

/** Cut at a paragraph boundary near `chars`. */
function slice(text, start, chars) {
  const end = Math.min(text.length, start + chars);
  if (end >= text.length) return text.slice(start);
  const nl = text.lastIndexOf("\n\n", end);
  return text.slice(start, nl > start + chars * 0.7 ? nl : end);
}

/** Deterministic maths text: worked arithmetic chains and word problems with their solutions. */
function mathsText(seed, chars) {
  const rand = mulberry32(seed);
  const int = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));
  const out = [];
  let n = 0;
  while (out.join("\n\n").length < chars) {
    n += 1;
    let v = int(100, 999);
    const lines = [`Problem ${n}. Start with ${v}.`];
    for (let step = 1; step <= 6; step++) {
      const op = int(0, 3);
      if (op === 0) {
        const k = int(2, 9);
        lines.push(`Step ${step}: multiply by ${k}: ${v} × ${k} = ${v * k}.`);
        v *= k;
      } else if (op === 1) {
        const k = int(100, 2000);
        lines.push(`Step ${step}: add ${k}: ${v} + ${k} = ${v + k}.`);
        v += k;
      } else if (op === 2) {
        const k = int(2, 9);
        const q = Math.floor(v / k);
        lines.push(`Step ${step}: divide by ${k}, rounding down: ⌊${v} / ${k}⌋ = ${q}.`);
        v = q;
      } else {
        const k = int(7, 97);
        lines.push(`Step ${step}: take the remainder modulo ${k}: ${v} mod ${k} = ${v % k}, then add 1000: ${(v % k) + 1000}.`);
        v = (v % k) + 1000;
      }
    }
    lines.push(`The final number is ${v}.`);
    const a = int(3, 40);
    const b = int(2, 9);
    const c = int(5, 60);
    lines.push(
      `A related word problem: a crate holds ${a} boxes of ${b} jars each, and ${c} more jars arrive loose. The total is ${a} × ${b} + ${c} = ${a * b + c} jars; split evenly among ${b} shelves that is ${Math.floor((a * b + c) / b)} jars per shelf with ${(a * b + c) % b} left over.`
    );
    out.push(lines.join("\n"));
  }
  return out.join("\n\n");
}

/** The values of a locale catalogue as running text (the keys are code, the values are language). */
function localeText(rel, chars) {
  const data = JSON.parse(read(rel));
  const values = [];
  const walk = (v) => {
    if (typeof v === "string") values.push(v);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(data);
  const text = values.filter((s) => s.length > 12).join("\n");
  return text.slice(0, chars);
}

const readme = read("README.md");
const codebase = read("CODEBASE.md");
const docs = [
  { id: "prose-readme-a", kind: "prose", lang: "en", source: "README.md (first part)", text: slice(readme, 0, 22000) },
  { id: "prose-readme-b", kind: "prose", lang: "en", source: "README.md (second part)", text: slice(readme, 22000, 22000) },
  { id: "prose-codebase", kind: "prose", lang: "en", source: "CODEBASE.md", text: slice(codebase, 0, 20000) },
  { id: "code-shared", kind: "code", lang: "js", source: "src/shared/qualityBench.js", text: slice(read("src/shared/qualityBench.js"), 0, 16000) },
  { id: "code-streaming", kind: "code", lang: "js", source: "server/collectors/LlmStreaming.js", text: slice(read("server/collectors/LlmStreaming.js"), 0, 16000) },
  { id: "code-atomic", kind: "code", lang: "js", source: "server/util/atomicWrite.js", text: read("server/util/atomicWrite.js") },
  { id: "maths-worked", kind: "maths", lang: "en", source: "seeded generator (mulberry32 seed 4242)", text: mathsText(4242, 12000) },
  { id: "multi-zh-statistics", kind: "multilingual", lang: "zh-CN", source: "src/locales/zh-CN/statistics.json values", text: localeText("src/locales/zh-CN/statistics.json", 6000) },
  { id: "multi-zh-spark", kind: "multilingual", lang: "zh-CN", source: "src/locales/zh-CN/spark.json values", text: localeText("src/locales/zh-CN/spark.json", 5000) },
].map((d) => ({ ...d, text: d.text.replace(/\r\n/g, "\n").trimEnd(), chars: 0, sha256: "" }));
for (const d of docs) {
  d.chars = d.text.length;
  d.sha256 = sha(d.text);
}
const corpus = {
  version: CORPUS_VERSION,
  builtAt: new Date().toISOString().slice(0, 10),
  licence: "MIT (this repository) and the bench's own seeded generator",
  sha256: sha(docs.map((d) => d.sha256).join("\n")),
  docs,
};
writeFileSync(OUT, `${JSON.stringify(corpus, null, 1)}\n`);
for (const d of docs) console.log(`${d.id.padEnd(22)} ${String(d.chars).padStart(6)} chars  ~${Math.round(d.chars / (d.lang === "zh-CN" ? 1.4 : 3.6)).toString().padStart(5)} tokens  ${d.sha256.slice(0, 12)}`);
console.log(`corpus v${CORPUS_VERSION} ${corpus.sha256.slice(0, 16)} · ${docs.reduce((n, d) => n + d.chars, 0)} chars in ${docs.length} docs → ${OUT}`);
