/**
 * Quality-bench constants + run comparison — shared by the Node runner and the
 * React dialog (pure, no I/O).
 */

/**
 * Run order and display order. "fidelity" scores a corpus by log-probabilities and "divergence"
 * compares stored replies; neither has a pass rate or enters the overall.
 */
export const QUALITY_CATEGORIES = ["qa", "reason", "arith", "track", "gsm8k", "mmlupro", "math500", "mmlu", "follow", "long", "tokenizer", "fidelity", "divergence"];

/** Categories without a pass rate (graded or structural): out of the overall and of the McNemar pairing. */
export const QUALITY_GRADED_CATEGORIES = ["fidelity", "divergence"];

/** The generation categories: everything that has a pass/fail per item. */
export const QUALITY_GENERATION_CATEGORIES = ["qa", "reason", "arith", "track", "gsm8k", "mmlupro", "math500", "mmlu", "follow", "long", "tokenizer"];
/** The suite v1 generation set, so runs saved before the Tokenizer category still read as "full". */
const QUALITY_GENERATION_CATEGORIES_V1 = ["qa", "reason", "arith", "track", "gsm8k", "mmlu", "follow", "long"];
/** The "full" set of suite v2 before the datasets step (with the Tokenizer category, plain MMLU only). */
const QUALITY_GENERATION_CATEGORIES_V2A = ["qa", "reason", "arith", "track", "gsm8k", "mmlu", "follow", "long", "tokenizer"];

export const QUALITY_DEFAULT_CATEGORIES = ["qa", "reason", "arith", "track", "gsm8k", "mmlupro"];
/** The default set before MMLU-Pro replaced plain MMLU, so older runs still read as "default". */
const QUALITY_DEFAULT_CATEGORIES_V1 = ["qa", "reason", "arith", "track", "gsm8k", "mmlu"];

export const QUALITY_CATEGORY_LABELS = {
  qa: "QA",
  reason: "Reasoning",
  arith: "Arithmetic chain",
  track: "State tracking",
  gsm8k: "GSM8K (Platinum)",
  mmlupro: "MMLU-Pro",
  math500: "MATH-500",
  mmlu: "MMLU",
  follow: "Instruction following",
  long: "Long-context recall",
  tokenizer: "Tokenizer",
  fidelity: "Fidelity",
  divergence: "Divergence",
};

/** Needle-recall sizes (tokens). Labels match the prefill bench (8k … 256k). */
export const QUALITY_LONG_SIZES = [8192, 16384, 32768, 65536, 131072, 262144];
export const QUALITY_DEFAULT_LONG_SIZES = [32768];
/** Suite v2: three items per size cover the three needle depths once; more only tightens an all-or-nothing score. */
export const QUALITY_DEFAULT_LONG_ITEMS = 3;
export const QUALITY_MAX_LONG_ITEMS = 5;

export const QUALITY_DEFAULT_CONCURRENCY = 4;

/**
 * Why a row is left out of a category's score, or null when it counts.
 *  - "error": the request failed or timed out; the model never answered.
 *  - "truncated": the reply hit `max_tokens` before committing to an answer (a model that
 *    reasons in the visible reply with thinking off, or a budget too small for it); the
 *    bench could not measure the item under its settings, so it is reported, not failed.
 *  - "disputed": the item's reference answer is known to be wrong or ambiguous (see
 *    GSM8K_DISPUTED in qualitySuite.js); it still runs so runs pair by id, but it never
 *    moves the score.
 * A reply that hit `max_tokens` after its answer line still counts (it passed or failed
 * on what it committed to).
 * @param {{ ok?: boolean, error?: string | null, finishReason?: string | null, disputed?: boolean | string | null }} row
 * @returns {"error" | "truncated" | "disputed" | null}
 */
export function qualityRowUnscored(row) {
  if (!row) return null;
  if (row.error) return "error";
  if (row.disputed) return "disputed";
  if (!row.ok && row.finishReason === "length") return "truncated";
  return null;
}
export const QUALITY_MAX_CONCURRENCY = 16;
export const QUALITY_LABEL_MAX = 60;

/**
 * One line naming the build a run scored (WP0 engine record): engine and version, quantisation,
 * KV dtype, tensor-parallel size, speculative decoding, checkpoint hash prefix. "" when unknown.
 * @param {{ backend?: string | null, engineVersion?: string | null, quantization?: { quant_method?: string, bits?: number, scope?: string } | null,
 *   kvCacheDtype?: string | null, tensorParallel?: number | null, speculative?: { enabled?: boolean, kind?: string } | null,
 *   checkpointSha256?: string | null } | null | undefined} rec
 */
export function engineRecordLine(rec) {
  if (!rec) return "";
  const parts = [];
  if (rec.backend || rec.engineVersion) parts.push([rec.backend, rec.engineVersion].filter(Boolean).join(" "));
  const q = rec.quantization;
  if (q) parts.push([q.quant_method, q.bits != null ? `${q.bits}-bit` : null, q.scope].filter(Boolean).join(" "));
  if (rec.kvCacheDtype) parts.push(`KV ${rec.kvCacheDtype}`);
  if (rec.tensorParallel != null && rec.tensorParallel > 1) parts.push(`TP ${rec.tensorParallel}`);
  if (rec.speculative?.enabled) parts.push(`spec ${rec.speculative.kind || "on"}`);
  if (rec.checkpointSha256) parts.push(`ckpt ${String(rec.checkpointSha256).slice(0, 12)}`);
  return parts.join(" · ");
}

/** Named category sets: only these carry a headline overall (a partial run is labelled by its categories). */
export const QUALITY_PROFILES = {
  default: [...QUALITY_DEFAULT_CATEGORIES],
  full: [...QUALITY_GENERATION_CATEGORIES],
  fidelity: ["fidelity"],
};

/**
 * WP4: the model family a run belongs to, for reference pinning: the model id without its path,
 * case, and the usual quantisation / precision suffixes, so "GLM-5.3-Flash-FP8" and
 * "glm-5.3-flash-exl3-4bit" share a reference. "" when the id is unknown.
 * @param {string | null | undefined} modelId
 */
export function qualityFamilyKey(modelId) {
  let s = String(modelId ?? "").trim().toLowerCase();
  if (!s) return "";
  s = s.split(/[\\/]/).filter(Boolean).pop() || s;
  s = s.replace(/\.(gguf|safetensors|bin)$/g, "");
  const quant = /[-_.](?:fp8|fp16|fp4|bf16|f16|f32|int4|int8|nvfp4|mxfp4|awq|gptq|gguf|exl[23]|w4a16|w8a16|w8a8|q[2-8](?:_[a-z0-9]+)*|iq[1-4][a-z_]*|[2-8]bit|[2-8]-bit|quantized|dynamic)(?=[-_.]|$)/g;
  let prev;
  do {
    prev = s;
    s = s.replace(quant, "");
  } while (s !== prev);
  return s.replace(/[-_.]+$/g, "");
}

/** The non-inferiority margin (points) an equivalence verdict needs: the paired delta's CI must sit inside ±margin. */
export const QUALITY_EQUIVALENCE_MARGIN_PTS = 2;

/**
 * "default" | "full" | "fidelity" | "custom" for a run's category list (order ignored). Fidelity has
 * no pass rate and never enters the overall, so it does not change a generation profile: the default
 * six plus fidelity is still "default"; fidelity alone is "fidelity".
 */
export function qualityProfile(categories) {
  const list = Array.isArray(categories) ? categories : [];
  const generation = new Set(list.filter((c) => !QUALITY_GRADED_CATEGORIES.includes(c)));
  if (!generation.size) return list.some((c) => QUALITY_GRADED_CATEGORIES.includes(c)) ? "fidelity" : "custom";
  for (const [name, cats] of [
    ["default", QUALITY_PROFILES.default],
    ["default", QUALITY_DEFAULT_CATEGORIES_V1],
    ["full", QUALITY_PROFILES.full],
    ["full", QUALITY_GENERATION_CATEGORIES_V2A],
    ["full", QUALITY_GENERATION_CATEGORIES_V1],
  ]) {
    if (cats.length === generation.size && cats.every((c) => generation.has(c))) return name;
  }
  return "custom";
}

/**
 * 95 % interval of a graded category's share (arithmetic steps, tracked people, long-recall keys)
 * by resampling items, since grades are clustered within an item. null without graded rows.
 * @param {Array<{ category: string, gradeCorrect?: number, gradeTotal?: number, error?: string | null }>} rows
 * @param {string} category
 */
export function gradedBootstrapCi(rows, category) {
  const items = (rows || []).filter((r) => r.category === category && !r.error && Number(r.gradeTotal) > 0);
  if (!items.length) return null;
  const rand = bootstrapRng(BOOTSTRAP_SEED + 3);
  const samples = new Array(BOOTSTRAP_REPS);
  for (let rep = 0; rep < BOOTSTRAP_REPS; rep++) {
    let found = 0;
    let total = 0;
    for (let i = 0; i < items.length; i++) {
      const r = items[Math.floor(rand() * items.length)];
      found += Number(r.gradeCorrect) || 0;
      total += Number(r.gradeTotal) || 0;
    }
    samples[rep] = total ? (found / total) * 100 : 0;
  }
  return percentileCi(samples);
}

/**
 * Wilson 95 % score interval for k passes out of n, in percent with one decimal: [lo, hi], or null
 * when n is 0. Wilson stays inside 0–100 and behaves at 0 % and 100 %, where the normal interval does not.
 * @param {number} k
 * @param {number} n
 * @param {number} [z]
 */
export function wilsonInterval(k, n, z = 1.959964) {
  const nn = Math.max(0, Number(n) || 0);
  if (!nn) return null;
  const p = Math.min(1, Math.max(0, (Number(k) || 0) / nn));
  const z2 = z * z;
  const denom = 1 + z2 / nn;
  const centre = (p + z2 / (2 * nn)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / nn + z2 / (4 * nn * nn))) / denom;
  const r = (v) => Math.round(Math.min(1, Math.max(0, v)) * 1000) / 10;
  return [r(centre - half), r(centre + half)];
}

/** Deterministic PRNG (mulberry32) so a bootstrap interval is the same on every render and on the server. */
function bootstrapRng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const BOOTSTRAP_REPS = 1000;
const BOOTSTRAP_SEED = 20261105;

/** 2.5th and 97.5th percentiles of the samples, one decimal. */
function percentileCi(samples) {
  if (!samples.length) return null;
  const s = [...samples].sort((x, y) => x - y);
  const at = (q) => s[Math.min(s.length - 1, Math.max(0, Math.floor(q * (s.length - 1))))];
  return [Math.round(at(0.025) * 10) / 10, Math.round(at(0.975) * 10) / 10];
}

function resampleMean(values, rand) {
  const n = values.length;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += values[Math.floor(rand() * n)];
  return sum / n;
}

/**
 * 95 % interval for the overall (mean of category pass rates) by a stratified bootstrap: items are
 * resampled within each category, so the overall's uncertainty follows the category sizes it is
 * made of. Unscored rows are left out as in the score. null without scored rows.
 * @param {Array<{ category: string, ok?: boolean }>} rows
 * @param {string[] | null} [onlyCategories] restrict to these categories (the shared ones in a comparison)
 */
export function overallBootstrapCi(rows, onlyCategories = null) {
  /** @type {Record<string, number[]>} */
  const groups = {};
  for (const r of rows || []) {
    if (QUALITY_GRADED_CATEGORIES.includes(r.category) || qualityRowUnscored(r)) continue;
    if (onlyCategories && !onlyCategories.includes(r.category)) continue;
    (groups[r.category] || (groups[r.category] = [])).push(r.ok ? 1 : 0);
  }
  const cats = Object.values(groups);
  if (!cats.length) return null;
  const rand = bootstrapRng(BOOTSTRAP_SEED);
  const samples = new Array(BOOTSTRAP_REPS);
  for (let rep = 0; rep < BOOTSTRAP_REPS; rep++) {
    let acc = 0;
    for (const g of cats) acc += resampleMean(g, rand);
    samples[rep] = (acc / cats.length) * 100;
  }
  return percentileCi(samples);
}

/**
 * 95 % interval for long-context recall's keys-found share, resampling prompts (keys are clustered
 * within a prompt, so resampling keys would understate the uncertainty). null without long rows.
 * @param {Array<{ category: string, longCorrect?: number, longTotal?: number, error?: string | null }>} rows
 */
export function longKeysBootstrapCi(rows) {
  const prompts = (rows || []).filter((r) => r.category === "long" && !r.error && Number(r.longTotal) > 0);
  if (!prompts.length) return null;
  const rand = bootstrapRng(BOOTSTRAP_SEED + 1);
  const samples = new Array(BOOTSTRAP_REPS);
  for (let rep = 0; rep < BOOTSTRAP_REPS; rep++) {
    let found = 0;
    let total = 0;
    for (let i = 0; i < prompts.length; i++) {
      const r = prompts[Math.floor(rand() * prompts.length)];
      found += Number(r.longCorrect) || 0;
      total += Number(r.longTotal) || 0;
    }
    samples[rep] = total ? (found / total) * 100 : 0;
  }
  return percentileCi(samples);
}

/**
 * 95 % interval of the paired difference A − B in points by a stratified paired bootstrap: pairs are
 * resampled within each category and the category deltas averaged (one category: its own delta).
 * @param {Record<string, Array<[number, number]>>} pairsByCategory per category, [okA, okB] as 0/1
 */
export function pairedDeltaBootstrapCi(pairsByCategory) {
  const groups = Object.values(pairsByCategory || {}).filter((g) => g.length > 0);
  if (!groups.length) return null;
  const rand = bootstrapRng(BOOTSTRAP_SEED + 2);
  const diffs = groups.map((g) => g.map(([a, b]) => a - b));
  const samples = new Array(BOOTSTRAP_REPS);
  for (let rep = 0; rep < BOOTSTRAP_REPS; rep++) {
    let acc = 0;
    for (const d of diffs) acc += resampleMean(d, rand);
    samples[rep] = (acc / diffs.length) * 100;
  }
  return percentileCi(samples);
}

/**
 * Holm–Bonferroni step-down adjustment of several p-values tested together (the categories of one
 * comparison), in the input order; monotone and capped at 1.
 * @param {number[]} ps
 */
export function holmAdjust(ps) {
  const m = ps.length;
  const order = ps.map((p, i) => [p, i]).sort((x, y) => x[0] - y[0]);
  const out = new Array(m).fill(1);
  let running = 0;
  for (let rank = 0; rank < m; rank++) {
    const [p, i] = order[rank];
    running = Math.max(running, Math.min(1, (m - rank) * p));
    out[i] = running;
  }
  return out;
}

/**
 * The intervals a finished run stores (and a viewer recomputes for runs saved without them):
 * the overall's stratified bootstrap and, for long-context recall, the prompt-clustered keys interval.
 * Wilson intervals per category come from the summary counts (see `summarize`).
 * @param {Array<object>} rows
 */
export function qualityIntervals(rows) {
  const out = { overallCi: overallBootstrapCi(rows), keysCi: null, gradeCi: {} };
  if ((rows || []).some((r) => r.category === "long")) out.keysCi = longKeysBootstrapCi(rows);
  for (const category of new Set((rows || []).filter((r) => Number(r.gradeTotal) > 0).map((r) => r.category))) {
    out.gradeCi[category] = gradedBootstrapCi(rows, category);
  }
  return out;
}

/**
 * Exact two-sided McNemar p-value from the discordant counts b and c:
 * p = min(1, 2 * sum_{i<=min(b,c)} C(b+c, i) / 2^(b+c)).
 * @param {number} b
 * @param {number} c
 */
export function mcnemarExactP(b, c) {
  const nb = Math.max(0, Math.floor(Number(b) || 0));
  const nc = Math.max(0, Math.floor(Number(c) || 0));
  const n = nb + nc;
  if (n === 0) return 1;
  const k = Math.min(nb, nc);
  // pmf(i) = C(n,i) / 2^n, built iteratively in log space to stay finite.
  let logPmf = -n * Math.LN2;
  let sum = 0;
  for (let i = 0; i <= k; i++) {
    sum += Math.exp(logPmf);
    logPmf += Math.log(n - i) - Math.log(i + 1);
  }
  return Math.min(1, 2 * sum);
}

/** Versions stored in a run's config; runs saved before they existed were suite 1 / scoring 1. */
function versionsOf(run) {
  const c = run?.config ?? {};
  return {
    suite: Number.isFinite(Number(c.suiteVersion)) && Number(c.suiteVersion) > 0 ? Number(c.suiteVersion) : 1,
    scoring: Number.isFinite(Number(c.scoringVersion)) && Number(c.scoringVersion) > 0 ? Number(c.scoringVersion) : 1,
  };
}

/**
 * Can two runs be paired item-by-item? Different suite versions mean different items/seeds under
 * the same ids; different scoring versions mean the same reply can pass in one and fail in the
 * other. Both make a McNemar table meaningless, so comparison is refused.
 * @returns {{ ok: boolean, reason: string | null }}
 */
export function checkQualityComparable(a, b) {
  if (!a || !b) return { ok: true, reason: null };
  const va = versionsOf(a);
  const vb = versionsOf(b);
  if (va.suite !== vb.suite) {
    return {
      ok: false,
      reason: `These runs used different item sets (suite v${va.suite} vs v${vb.suite}), so items with the same id are not the same question. Re-run one of them to compare.`,
    };
  }
  if (va.scoring !== vb.scoring) {
    return {
      ok: false,
      reason: `These runs were scored by different rules (scoring v${va.scoring} vs v${vb.scoring}), so a pass in one is not a pass in the other. Re-run one of them to compare.`,
    };
  }
  return { ok: true, reason: null };
}

/**
 * Pair two quality runs by item id, per category. Pairs where either side is unscored (a request
 * error or timeout, a reply cut off by `max_tokens` before its answer, or a disputed item; see
 * qualityRowUnscored) are left out of the table and counted in `excluded`: they are neither
 * passes nor failures. Returns [] when the runs are not comparable
 * (see checkQualityComparable).
 *
 * @param {{ config?: object, results?: { categories?: Record<string, { passed: number, total: number, pct: number | null }>, items?: Array<{ id: string, category: string, ok: boolean, error?: string | null, hash?: string | null }> } } | null} a
 * @param {typeof a} b
 * @returns {Array<{
 *   category: string,
 *   pctA: number | null, pctB: number | null,
 *   paired: number, excluded: number, identical: number, bothOk: number, bothFail: number,
 *   onlyA: number, onlyB: number, p: number, withinNoise: boolean,
 * }>}
 */
export function compareQualityRuns(a, b, { margin = QUALITY_EQUIVALENCE_MARGIN_PTS } = {}) {
  if (!checkQualityComparable(a, b).ok) return [];
  const acc = pairRuns(a, b);
  const rows = [];
  for (const category of QUALITY_CATEGORIES) {
    const row = acc.get(category);
    if (!row) continue;
    const { pairs, ...counts } = row;
    const p = mcnemarExactP(row.onlyA, row.onlyB);
    const sa = a?.results?.categories?.[category] ?? {};
    const sb = b?.results?.categories?.[category] ?? {};
    const deltaCi = row.paired ? pairedDeltaBootstrapCi({ [category]: pairs }) : null;
    rows.push({
      category,
      pctA: sa.pct ?? null,
      pctB: sb.pct ?? null,
      // Coverage beside accuracy: scored ÷ total and passed ÷ everything that ran, both runs.
      coverageA: sa.coveragePct ?? null,
      coverageB: sb.coveragePct ?? null,
      budgetedA: sa.budgetedPct ?? null,
      budgetedB: sb.budgetedPct ?? null,
      ...counts,
      // The paired delta over the paired items only (the category pcts can rest on different denominators).
      pairedPctA: row.paired ? Math.round(((row.bothOk + row.onlyA) / row.paired) * 1000) / 10 : null,
      pairedPctB: row.paired ? Math.round(((row.bothOk + row.onlyB) / row.paired) * 1000) / 10 : null,
      deltaPts: row.paired ? Math.round(((row.onlyA - row.onlyB) / row.paired) * 1000) / 10 : null,
      deltaCi,
      equivalent: deltaCi != null && deltaCi[0] >= -margin && deltaCi[1] <= margin,
      margin,
      p,
      pAdj: p,
      withinNoise: p >= 0.05,
    });
  }
  // One comparison, several categories: Holm keeps the family-wise error at 5 %.
  const adj = holmAdjust(rows.map((r) => r.p));
  rows.forEach((r, i) => {
    r.pAdj = adj[i];
    r.verdict = r.onlyA + r.onlyB === 0 ? "same" : r.pAdj < 0.05 ? "different" : "insufficient";
  });
  return rows;
}

/**
 * The pooled overall of a comparison: the per-category tables summed for one exact McNemar test,
 * the mean of the category paired deltas with its stratified bootstrap interval, and the
 * equivalence call against `margin`. null when the runs are not comparable or share no items.
 * @param {Parameters<typeof compareQualityRuns>[0]} a
 * @param {Parameters<typeof compareQualityRuns>[1]} b
 */
export function compareQualityOverall(a, b, { margin = QUALITY_EQUIVALENCE_MARGIN_PTS } = {}) {
  if (!checkQualityComparable(a, b).ok) return null;
  const acc = pairRuns(a, b);
  if (!acc.size) return null;
  let paired = 0;
  let excluded = 0;
  let onlyA = 0;
  let onlyB = 0;
  /** @type {Record<string, Array<[number, number]>>} */
  const pairsByCategory = {};
  const deltas = [];
  for (const [category, row] of acc.entries()) {
    paired += row.paired;
    excluded += row.excluded;
    onlyA += row.onlyA;
    onlyB += row.onlyB;
    if (row.paired) {
      pairsByCategory[category] = row.pairs;
      deltas.push((row.onlyA - row.onlyB) / row.paired);
    }
  }
  const deltaCi = deltas.length ? pairedDeltaBootstrapCi(pairsByCategory) : null;
  return {
    categories: deltas.length,
    paired,
    excluded,
    onlyA,
    onlyB,
    p: mcnemarExactP(onlyA, onlyB),
    deltaPts: deltas.length ? Math.round((deltas.reduce((n, d) => n + d, 0) / deltas.length) * 1000) / 10 : null,
    deltaCi,
    equivalent: deltaCi != null && deltaCi[0] >= -margin && deltaCi[1] <= margin,
    margin,
  };
}

/** Pair two runs' rows by id per category; unscored pairs are counted in `excluded`, never in the table. */
function pairRuns(a, b) {
  const itemsA = Array.isArray(a?.results?.items) ? a.results.items : [];
  const itemsB = Array.isArray(b?.results?.items) ? b.results.items : [];
  const byIdB = new Map(itemsB.map((it) => [it.id, it]));
  /** @type {Map<string, { paired: number, excluded: number, identical: number, bothOk: number, bothFail: number, onlyA: number, onlyB: number, pairs: Array<[number, number]> }>} */
  const acc = new Map();
  for (const ia of itemsA) {
    const ib = byIdB.get(ia.id);
    // Graded categories (fidelity NLL, divergence replies) pair through their own compares, not here.
    if (!ib || ia.category !== ib.category || QUALITY_GRADED_CATEGORIES.includes(ia.category)) continue;
    let row = acc.get(ia.category);
    if (!row) {
      row = { paired: 0, excluded: 0, identical: 0, bothOk: 0, bothFail: 0, onlyA: 0, onlyB: 0, pairs: [] };
      acc.set(ia.category, row);
    }
    if (qualityRowUnscored(ia) || qualityRowUnscored(ib)) {
      row.excluded += 1;
      continue;
    }
    row.paired += 1;
    row.pairs.push([ia.ok ? 1 : 0, ib.ok ? 1 : 0]);
    if (ia.hash && ib.hash && ia.hash === ib.hash) row.identical += 1;
    if (ia.ok && ib.ok) row.bothOk += 1;
    else if (ia.ok) row.onlyA += 1;
    else if (ib.ok) row.onlyB += 1;
    else row.bothFail += 1;
  }
  return acc;
}
