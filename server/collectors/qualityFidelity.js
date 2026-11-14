/**
 * Quality bench, WP2: the Fidelity category. The model scores a fixed corpus by prompt
 * log-probabilities (non-streamed `/v1/completions`, `prompt_logprobs: K`, `max_tokens: 1`); nothing
 * is generated. Per document the bench keeps every position's actual token id, its logprob and rank,
 * and the top-K alternatives, in a gzipped side file next to the history
 * (config/quality-fidelity/<benchId>.json.gz), and reports token-weighted NLL, perplexity and bits
 * per byte. Two runs on the same corpus compare by paired ΔNLL with a bootstrap interval over
 * documents, top-1 agreement, tail loss (the reference's top-1 outside the test's top-K) and a
 * truncated-support divergence that is labelled a diagnostic, never a KL.
 *
 * The actual token at each position is identified by id: from the reply's `prompt_token_ids`
 * (TensorFold) or the engine's `/tokenize` route (vLLM). Without either the item is an error, not a
 * guess.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { gunzipSync, gzipSync } from "zlib";
import { fetch as undiciFetch } from "undici";
import { atomicWrite } from "../util/atomicWrite.js";
import { LLM_STREAM_AGENT, round2 } from "./LlmStreaming.js";
import { timeoutMsForSize } from "./PrefillBench.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");
export const FIDELITY_DIR = process.env.QUALITY_FIDELITY_DIR || path.join(ROOT, "config", "quality-fidelity");

/** Top-K alternatives asked for per position; capped by what the engine advertises or the probe found. */
export const FIDELITY_DEFAULT_K = 20;
/** Rough tokens per character for the timeout and the progress label. */
const CHARS_PER_TOKEN = 3;
const BOOTSTRAP_REPS = 1000;

const num = (v) => (Number.isFinite(Number(v)) && v !== null && v !== "" ? Number(v) : null);

/** The K to request: the default, or the engine's cap when that is lower. */
export function fidelityK(capabilities) {
  const cap = num(capabilities?.cap);
  return cap != null && cap >= 1 ? Math.min(FIDELITY_DEFAULT_K, cap) : FIDELITY_DEFAULT_K;
}

/** Per-item timeout: a long prefill plus a minute. */
export function timeoutMsForFidelityItem(item) {
  return timeoutMsForSize(Math.ceil((Number(item.chars) || 0) / CHARS_PER_TOKEN)) + 60_000;
}

async function postJson(fetchImpl, url, body, { apiKey, signal }) {
  /** @type {Record<string, string>} */
  const headers = { "Content-Type": "application/json", Accept: "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const res = await fetchImpl(url, { method: "POST", headers, body: JSON.stringify(body), signal, dispatcher: LLM_STREAM_AGENT });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: res.status, json, text: text.slice(0, 300) };
}

/**
 * Token ids for the prompt when the reply does not carry them: vLLM's `/tokenize`. null when the
 * engine has no such route.
 */
async function tokenizeFallback(fetchImpl, baseUrl, modelId, prompt, opts) {
  try {
    const r = await postJson(fetchImpl, `${baseUrl}/tokenize`, { model: modelId || undefined, prompt, add_special_tokens: false }, opts);
    const ids = r.json?.tokens;
    return r.status === 200 && Array.isArray(ids) && ids.every((t) => Number.isInteger(t)) ? ids : null;
  } catch {
    return null;
  }
}

/**
 * Turn a vLLM-shaped `prompt_logprobs` reply into per-position arrays. Position 0 has no
 * distribution; `ids` must line up with the rows (with or without a BOS the engine added).
 * @returns {{ ids: number[], lp: number[], rank: number[], top: Array<Array<[number, number]>> } | { error: string }}
 */
export function parsePromptLogprobs(rows, ids, k) {
  if (!Array.isArray(rows) || rows.length < 2) return { error: "no prompt_logprobs rows" };
  if (!Array.isArray(ids)) return { error: "token ids unavailable: the engine returned neither prompt_token_ids nor a /tokenize route" };
  // rows.length === ids.length: ids cover every position (BOS included when the engine added one).
  // rows.length === ids.length + 1: the engine prepended a token the tokenizer did not report.
  let offset;
  if (ids.length === rows.length) offset = 0;
  else if (ids.length + 1 === rows.length) offset = 1;
  else return { error: `token ids (${ids.length}) do not line up with the ${rows.length} scored positions` };
  const outIds = [];
  const lp = [];
  const rank = [];
  const top = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const id = ids[i - offset];
    if (!row || typeof row !== "object") return { error: `position ${i} carries no distribution` };
    const actual = row[String(id)];
    if (!actual || !Number.isFinite(Number(actual.logprob))) return { error: `the actual token (id ${id}) is missing from position ${i}` };
    outIds.push(id);
    lp.push(Number(actual.logprob));
    rank.push(num(actual.rank) ?? 0);
    const alts = Object.entries(row)
      .map(([tid, e]) => [Number(tid), Number(e?.logprob)])
      .filter(([tid, l]) => Number.isInteger(tid) && Number.isFinite(l))
      .sort((a, b) => b[1] - a[1])
      .slice(0, k)
      .map(([tid, l]) => [tid, Math.round(l * 10000) / 10000]);
    top.push(alts);
  }
  return { ids: outIds, lp, rank, top };
}

/**
 * One fidelity item: request, parse, score. Returns the result row and the per-position side data
 * (kept apart from the row so the history stays small).
 * @returns {Promise<{ row: object, side: object | null }>}
 */
export async function runFidelityItem({ baseUrl, modelId, item, k = FIDELITY_DEFAULT_K, abortSignal = null, apiKey = null, fetchImpl = undiciFetch }) {
  const timeoutMs = timeoutMsForFidelityItem(item);
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = abortSignal ? AbortSignal.any([abortSignal, timeout]) : timeout;
  const t0 = performance.now();
  const row = {
    id: item.id,
    category: "fidelity",
    ok: false,
    excerpt: "",
    hash: item.docSha256 ? String(item.docSha256).slice(0, 16) : "",
    finishReason: null,
    completionTokens: 0,
    promptTokens: 0,
    durationMs: 0,
    error: null,
    detail: null,
    thinking: false,
    docId: item.docId,
    kind: item.kind,
    lang: item.lang,
    bytes: item.bytes,
    k,
  };
  try {
    const r = await postJson(
      fetchImpl,
      `${baseUrl}/v1/completions`,
      { model: modelId || undefined, prompt: item.prompt, max_tokens: 1, temperature: 0, stream: false, prompt_logprobs: k },
      { apiKey, signal }
    );
    row.durationMs = round2(performance.now() - t0);
    if (r.status !== 200) {
      row.error = `HTTP ${r.status}: ${r.json?.error?.message || r.text || "no body"}`;
      return { row, side: null };
    }
    const choice = r.json?.choices?.[0];
    const rows = choice?.prompt_logprobs;
    if (!Array.isArray(rows)) {
      row.error = "the reply carries no prompt_logprobs";
      return { row, side: null };
    }
    let ids = Array.isArray(choice.prompt_token_ids) ? choice.prompt_token_ids : null;
    if (!ids) ids = await tokenizeFallback(fetchImpl, baseUrl, modelId, item.prompt, { apiKey, signal });
    const parsed = parsePromptLogprobs(rows, ids, k);
    if ("error" in parsed) {
      row.error = parsed.error;
      return { row, side: null };
    }
    const n = parsed.lp.length;
    const sumNll = -parsed.lp.reduce((s, v) => s + v, 0);
    row.ok = true;
    row.promptTokens = num(r.json?.usage?.prompt_tokens) ?? rows.length;
    row.tokens = n;
    row.sumNll = Math.round(sumNll * 10000) / 10000;
    row.nll = Math.round((sumNll / n) * 10000) / 10000;
    row.ppl = Math.round(Math.exp(sumNll / n) * 1000) / 1000;
    row.bitsPerByte = item.bytes ? Math.round((sumNll / Math.LN2 / item.bytes) * 10000) / 10000 : null;
    row.top1Pct = Math.round((parsed.rank.filter((rk) => rk === 1).length / n) * 1000) / 10;
    row.excerpt = `NLL ${row.nll.toFixed(3)} · ppl ${row.ppl.toFixed(2)} · ${n.toLocaleString("en-US")} tokens`;
    row.detail = `${item.kind} · ${item.lang} · top-1 ${row.top1Pct}% · K ${k}`;
    return { row, side: { ids: parsed.ids, lp: parsed.lp.map((v) => Math.round(v * 10000) / 10000), rank: parsed.rank, top: parsed.top } };
  } catch (err) {
    row.durationMs = round2(performance.now() - t0);
    row.error = timeout.aborted && !abortSignal?.aborted ? `Timed out after ${Math.round(timeoutMs / 1000)}s` : err?.message || String(err);
    return { row, side: null };
  }
}

// ── Side files ───────────────────────────────────────────────────────────────────────────────

function sidePath(benchId, dir = FIDELITY_DIR) {
  return path.join(dir, `${String(benchId).replace(/[^a-zA-Z0-9-]/g, "")}.json.gz`);
}

/** Write a run's side data (gzipped JSON, atomic). */
export function writeFidelitySide(benchId, data, dir = FIDELITY_DIR) {
  atomicWrite(sidePath(benchId, dir), gzipSync(Buffer.from(JSON.stringify(data))), 0o600);
}

/** @returns {object | null} the side data, or null when the run has none */
export function readFidelitySide(benchId, dir = FIDELITY_DIR) {
  const p = sidePath(benchId, dir);
  try {
    if (!fs.existsSync(p)) return null;
    return JSON.parse(gunzipSync(fs.readFileSync(p)).toString("utf8"));
  } catch (err) {
    console.warn(`[QualityBench] fidelity side file unreadable for ${benchId}:`, err?.message || err);
    return null;
  }
}

export function deleteFidelitySide(benchId, dir = FIDELITY_DIR) {
  try {
    fs.unlinkSync(sidePath(benchId, dir));
  } catch {
    /* none */
  }
}

/** Drop side files of runs no longer in any history list. */
export function pruneFidelitySides(keepIds, dir = FIDELITY_DIR) {
  const keep = new Set(keepIds);
  let entries = [];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (!name.endsWith(".json.gz")) continue;
    const id = name.slice(0, -".json.gz".length);
    if (!keep.has(id)) deleteFidelitySide(id, dir);
  }
}

// ── Comparison ───────────────────────────────────────────────────────────────────────────────

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const r4 = (v) => Math.round(v * 10000) / 10000;

/**
 * Compare a test run's side data (A) against a reference run's (B), document by document. Only
 * documents whose token ids match exactly are paired; the rest are reported as mismatched.
 * @param {{ k?: number, corpusSha256?: string, docs: Record<string, { ids: number[], lp: number[], top?: Array<Array<[number, number]>> }> } | null} a
 * @param {typeof a} b
 */
export function compareFidelity(a, b) {
  if (!a || !b) return { comparable: false, reason: "one of the runs has no fidelity data" };
  if (a.corpusSha256 && b.corpusSha256 && a.corpusSha256 !== b.corpusSha256) {
    return { comparable: false, reason: "the runs scored different corpus versions" };
  }
  const docs = [];
  let mismatched = 0;
  for (const [id, da] of Object.entries(a.docs || {})) {
    const db = b.docs?.[id];
    if (!db) continue;
    const n = da.lp.length;
    const match = n === db.lp.length && da.ids.length === db.ids.length && da.ids.every((v, i) => v === db.ids[i]);
    if (!match) {
      mismatched += 1;
      docs.push({ id, tokens: n, match: false });
      continue;
    }
    let sumA = 0;
    let sumB = 0;
    let top1 = 0;
    let tail = 0;
    let div = 0;
    let divN = 0;
    for (let i = 0; i < n; i++) {
      sumA -= da.lp[i];
      sumB -= db.lp[i];
      const ta = da.top?.[i];
      const tb = db.top?.[i];
      if (!ta?.length || !tb?.length) continue;
      if (ta[0][0] === tb[0][0]) top1 += 1;
      const inA = new Map(ta);
      if (!inA.has(tb[0][0])) tail += 1;
      // Truncated-support divergence, ref ‖ test, over the intersection of the two top-K lists with
      // the remaining mass in one "other" bucket. A diagnostic: not a KL estimate.
      let pa = 0;
      let pb = 0;
      let d = 0;
      for (const [tid, lb] of tb) {
        const la = inA.get(tid);
        if (la == null) continue;
        const qb = Math.exp(lb);
        const qa = Math.exp(la);
        pa += qa;
        pb += qb;
        d += qb * (lb - la);
      }
      const oa = Math.max(1e-9, 1 - pa);
      const ob = Math.max(1e-9, 1 - pb);
      d += ob * Math.log(ob / oa);
      div += d;
      divN += 1;
    }
    docs.push({
      id,
      tokens: n,
      match: true,
      nllA: r4(sumA / n),
      nllB: r4(sumB / n),
      dNll: r4((sumA - sumB) / n),
      sumA,
      sumB,
      top1AgreementPct: divN ? Math.round((top1 / divN) * 1000) / 10 : null,
      tailLossPct: divN ? Math.round((tail / divN) * 1000) / 10 : null,
      divergence: divN ? r4(div / divN) : null,
      scoredTop: divN,
      top1Count: top1,
      tailCount: tail,
      divSum: div,
    });
  }
  const matched = docs.filter((d) => d.match);
  if (!matched.length) {
    return { comparable: false, reason: docs.length ? "no document tokenised identically in both runs" : "the runs share no documents", docs, mismatchedDocs: mismatched };
  }
  const tokens = matched.reduce((s, d) => s + d.tokens, 0);
  const sumA = matched.reduce((s, d) => s + d.sumA, 0);
  const sumB = matched.reduce((s, d) => s + d.sumB, 0);
  // Bootstrap over documents, token-weighted: the corpus ΔNLL under resampled document sets.
  const rand = rng(20261105);
  const samples = new Array(BOOTSTRAP_REPS);
  for (let rep = 0; rep < BOOTSTRAP_REPS; rep++) {
    let sa = 0;
    let sb = 0;
    let nt = 0;
    for (let i = 0; i < matched.length; i++) {
      const d = matched[Math.floor(rand() * matched.length)];
      sa += d.sumA;
      sb += d.sumB;
      nt += d.tokens;
    }
    samples[rep] = (sa - sb) / nt;
  }
  samples.sort((x, y) => x - y);
  const at = (q) => samples[Math.min(samples.length - 1, Math.max(0, Math.floor(q * (samples.length - 1))))];
  // Overall agreement, tail loss and divergence from the raw counts (not the rounded per-doc shares).
  const topN = matched.reduce((s, d) => s + d.scoredTop, 0);
  const share = (key) => (topN ? Math.round((matched.reduce((s, d) => s + d[key], 0) / topN) * 1000) / 10 : null);
  return {
    comparable: true,
    reason: null,
    k: { a: a.k ?? null, b: b.k ?? null },
    tokens,
    matchedDocs: matched.length,
    mismatchedDocs: mismatched,
    nllA: r4(sumA / tokens),
    nllB: r4(sumB / tokens),
    pplA: Math.round(Math.exp(sumA / tokens) * 1000) / 1000,
    pplB: Math.round(Math.exp(sumB / tokens) * 1000) / 1000,
    dNll: r4((sumA - sumB) / tokens),
    dNllCi: [r4(at(0.025)), r4(at(0.975))],
    top1AgreementPct: share("top1Count"),
    tailLossPct: share("tailCount"),
    divergence: topN ? r4(matched.reduce((s, d) => s + d.divSum, 0) / topN) : null,
    docs: docs.map(({ sumA: _a, sumB: _b, top1Count: _c, tailCount: _d, divSum: _e, ...rest }) => rest),
  };
}
