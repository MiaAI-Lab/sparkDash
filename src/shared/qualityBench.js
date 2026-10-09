/**
 * Quality-bench constants + run comparison — shared by the Node runner and the
 * React dialog (pure, no I/O).
 */

/** Run order and display order. */
export const QUALITY_CATEGORIES = ["qa", "reason", "arith", "track", "gsm8k", "mmlu", "follow", "long"];

export const QUALITY_DEFAULT_CATEGORIES = ["qa", "reason", "arith", "track", "gsm8k", "mmlu"];

export const QUALITY_CATEGORY_LABELS = {
  qa: "QA",
  reason: "Reasoning",
  arith: "Arithmetic chain",
  track: "State tracking",
  gsm8k: "GSM8K",
  mmlu: "MMLU",
  follow: "Instruction following",
  long: "Long-context recall",
};

/** Needle-recall sizes (tokens). Labels match the prefill bench (8k … 256k). */
export const QUALITY_LONG_SIZES = [8192, 16384, 32768, 65536, 131072, 262144];
export const QUALITY_DEFAULT_LONG_SIZES = [32768];
export const QUALITY_DEFAULT_LONG_ITEMS = 2;
export const QUALITY_MAX_LONG_ITEMS = 5;

export const QUALITY_DEFAULT_CONCURRENCY = 4;
export const QUALITY_MAX_CONCURRENCY = 16;
export const QUALITY_LABEL_MAX = 60;

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
 * Pair two quality runs by item id, per category. Pairs where either side hit a request error or
 * timeout (`error` set) are left out of the table and counted in `excluded`: the model never
 * answered, so they are neither passes nor failures. Returns [] when the runs are not comparable
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
export function compareQualityRuns(a, b) {
  if (!checkQualityComparable(a, b).ok) return [];
  const itemsA = Array.isArray(a?.results?.items) ? a.results.items : [];
  const itemsB = Array.isArray(b?.results?.items) ? b.results.items : [];
  const byIdB = new Map(itemsB.map((it) => [it.id, it]));
  /** @type {Map<string, { paired: number, excluded: number, identical: number, bothOk: number, bothFail: number, onlyA: number, onlyB: number }>} */
  const acc = new Map();
  for (const ia of itemsA) {
    const ib = byIdB.get(ia.id);
    if (!ib || ia.category !== ib.category) continue;
    let row = acc.get(ia.category);
    if (!row) {
      row = { paired: 0, excluded: 0, identical: 0, bothOk: 0, bothFail: 0, onlyA: 0, onlyB: 0 };
      acc.set(ia.category, row);
    }
    if (ia.error || ib.error) {
      row.excluded += 1;
      continue;
    }
    row.paired += 1;
    if (ia.hash && ib.hash && ia.hash === ib.hash) row.identical += 1;
    if (ia.ok && ib.ok) row.bothOk += 1;
    else if (ia.ok) row.onlyA += 1;
    else if (ib.ok) row.onlyB += 1;
    else row.bothFail += 1;
  }
  const out = [];
  for (const category of QUALITY_CATEGORIES) {
    const row = acc.get(category);
    if (!row) continue;
    const p = mcnemarExactP(row.onlyA, row.onlyB);
    out.push({
      category,
      pctA: a?.results?.categories?.[category]?.pct ?? null,
      pctB: b?.results?.categories?.[category]?.pct ?? null,
      ...row,
      p,
      withinNoise: p >= 0.05,
    });
  }
  return out;
}
