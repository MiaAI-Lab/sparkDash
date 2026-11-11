/**
 * Quality bench, WP3: the Divergence category's pure parts, shared by the runner and the dialog.
 *
 *  - `detectLoop` finds a repeating tail in a reply (a word-level cycle that covers a good share of
 *    the text): the failure mode of a bad quantisation or sampler that no accuracy score sees.
 *  - `compareDivergence` pairs two runs' replies by item: identical share, where they first diverge,
 *    normalised edit distance, length ratio, long-generation drift, and the structural rates on
 *    both sides. Reply identity measures sensitivity to the serving stack, not correctness.
 */

/** Character offsets at which long-generation drift is read (≈ 256 / 1,024 / 2,048 tokens of English). */
export const DIVERGENCE_DRIFT_CHARS = [1024, 4096, 8192];
/** Edit distance is computed on reply prefixes of this length (O(n·m) stays cheap). */
export const DIVERGENCE_EDIT_CHARS = 1200;

/**
 * A reply that ends in a cycle: the longest suffix where every word equals the word `cycle`
 * positions earlier, for the cycle length (1–60 words) that covers the most text. A loop needs at
 * least `minCycles` repetitions and `minTailShare` of the words.
 * @param {string} text
 * @returns {{ loop: boolean, cycle: number | null, tailShare: number }}
 */
export function detectLoop(text, { minCycles = 3, minTailShare = 0.3 } = {}) {
  const words = String(text ?? "").trim().split(/\s+/).filter(Boolean);
  const n = words.length;
  const none = { loop: false, cycle: null, tailShare: 0 };
  if (n < 24) return none;
  let best = none;
  let bestShare = 0;
  for (let cycle = 1; cycle <= Math.min(60, Math.floor(n / minCycles)); cycle++) {
    let i = n - 1;
    let run = 0;
    while (i - cycle >= 0 && words[i] === words[i - cycle]) {
      run += 1;
      i -= 1;
    }
    if (run < cycle * (minCycles - 1)) continue;
    const share = Math.min(1, (run + cycle) / n);
    // A multiple of the true period covers the same text: the smallest cycle wins the tie.
    if (share >= minTailShare && share > bestShare + 1e-9) {
      bestShare = share;
      best = { loop: true, cycle, tailShare: Math.round(share * 1000) / 1000 };
    }
  }
  return best;
}

/** Length of the common prefix of two strings, in characters. */
export function commonPrefixChars(a, b) {
  const x = String(a ?? "");
  const y = String(b ?? "");
  const n = Math.min(x.length, y.length);
  let i = 0;
  while (i < n && x.charCodeAt(i) === y.charCodeAt(i)) i += 1;
  return i;
}

/**
 * Normalised Levenshtein distance (0 = identical, 1 = nothing shared) over the first `cap`
 * characters of each string.
 */
export function editDistanceNorm(a, b, cap = DIVERGENCE_EDIT_CHARS) {
  const x = String(a ?? "").slice(0, cap);
  const y = String(b ?? "").slice(0, cap);
  if (!x.length && !y.length) return 0;
  if (!x.length || !y.length) return 1;
  let prev = new Array(y.length + 1);
  let cur = new Array(y.length + 1);
  for (let j = 0; j <= y.length; j++) prev[j] = j;
  for (let i = 1; i <= x.length; i++) {
    cur[0] = i;
    const cx = x.charCodeAt(i - 1);
    for (let j = 1; j <= y.length; j++) {
      const cost = cx === y.charCodeAt(j - 1) ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return Math.round((prev[y.length] / Math.max(x.length, y.length)) * 10000) / 10000;
}

function median(values) {
  if (!values.length) return null;
  const s = [...values].sort((p, q) => p - q);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

const mean = (values) => (values.length ? values.reduce((s, v) => s + v, 0) / values.length : null);
const pctOf = (k, n) => (n ? Math.round((k / n) * 1000) / 10 : null);

/** Structural rates of one run's divergence rows, with no reference needed. */
export function divergenceRates(rows) {
  const scored = (rows || []).filter((r) => r.category === "divergence" && !r.error);
  const json = scored.filter((r) => r.kind === "json");
  const tool = scored.filter((r) => r.kind === "tool");
  const loops = scored.filter((r) => r.loop?.loop).length;
  const terminated = scored.filter((r) => r.terminated).length;
  return {
    rows: scored.length,
    terminatedPct: pctOf(terminated, scored.length),
    loops,
    loopPct: pctOf(loops, scored.length),
    jsonValidPct: pctOf(json.filter((r) => r.json?.valid).length, json.length),
    jsonSchemaPct: pctOf(json.filter((r) => r.json?.schema).length, json.length),
    toolOkPct: pctOf(tool.filter((r) => r.tool?.nameOk && r.tool?.argsOk).length, tool.length),
    meanChars: scored.length ? Math.round(mean(scored.map((r) => Number(r.chars) || 0))) : null,
    meanTokens: scored.length ? Math.round(mean(scored.map((r) => Number(r.completionTokens) || 0))) : null,
  };
}

/**
 * Pair two runs' divergence rows (A = this run, B = the reference) by item id.
 * @param {{ results?: { items?: Array<object> } } | null} a
 * @param {typeof a} b
 */
export function compareDivergence(a, b) {
  const itemsA = (a?.results?.items ?? []).filter((r) => r.category === "divergence");
  const itemsB = (b?.results?.items ?? []).filter((r) => r.category === "divergence");
  if (!itemsA.length || !itemsB.length) return null;
  const byId = new Map(itemsB.map((r) => [r.id, r]));
  const pairs = [];
  for (const ra of itemsA) {
    const rb = byId.get(ra.id);
    if (!rb || ra.error || rb.error) continue;
    const ta = String(ra.reply ?? "");
    const tb = String(rb.reply ?? "");
    const identical = ra.hash && rb.hash ? ra.hash === rb.hash : ta === tb;
    const prefix = identical ? null : commonPrefixChars(ta, tb);
    pairs.push({
      id: ra.id,
      kind: ra.kind,
      identical,
      firstDivergence: prefix,
      editNorm: identical ? 0 : editDistanceNorm(ta, tb),
      lenRatio: tb.length ? Math.round((ta.length / tb.length) * 1000) / 1000 : null,
      charsA: ta.length,
      charsB: tb.length,
      loopA: Boolean(ra.loop?.loop),
      loopB: Boolean(rb.loop?.loop),
      terminatedA: Boolean(ra.terminated),
      terminatedB: Boolean(rb.terminated),
      drift: ra.kind === "long" ? DIVERGENCE_DRIFT_CHARS.map((at) => (identical ? true : prefix >= Math.min(at, ta.length, tb.length))) : null,
    });
  }
  if (!pairs.length) return null;
  /** @type {Record<string, { paired: number, identical: number, firstDivergence: number[], editNorm: number[] }>} */
  const byKind = {};
  for (const p of pairs) {
    const k = byKind[p.kind] || (byKind[p.kind] = { paired: 0, identical: 0, firstDivergence: [], editNorm: [] });
    k.paired += 1;
    if (p.identical) k.identical += 1;
    else k.firstDivergence.push(p.firstDivergence);
    k.editNorm.push(p.editNorm);
  }
  const kinds = {};
  for (const [kind, k] of Object.entries(byKind)) {
    kinds[kind] = {
      paired: k.paired,
      identicalPct: pctOf(k.identical, k.paired),
      medianFirstDivergence: median(k.firstDivergence),
      meanEditNorm: k.editNorm.length ? Math.round(mean(k.editNorm) * 10000) / 10000 : null,
    };
  }
  const longPairs = pairs.filter((p) => p.drift);
  const identicalCount = pairs.filter((p) => p.identical).length;
  const ratios = pairs.map((p) => p.lenRatio).filter((v) => v != null);
  return {
    paired: pairs.length,
    identical: identicalCount,
    identicalPct: pctOf(identicalCount, pairs.length),
    medianFirstDivergence: median(pairs.filter((p) => !p.identical).map((p) => p.firstDivergence)),
    meanEditNorm: Math.round(mean(pairs.map((p) => p.editNorm)) * 10000) / 10000,
    meanLenRatio: ratios.length ? Math.round(mean(ratios) * 1000) / 1000 : null,
    loopsA: pairs.filter((p) => p.loopA).length,
    loopsB: pairs.filter((p) => p.loopB).length,
    terminatedA: pairs.filter((p) => p.terminatedA).length,
    terminatedB: pairs.filter((p) => p.terminatedB).length,
    drift: longPairs.length
      ? DIVERGENCE_DRIFT_CHARS.map((chars, i) => ({ chars, identicalPct: pctOf(longPairs.filter((p) => p.drift[i]).length, longPairs.length), paired: longPairs.length }))
      : [],
    kinds,
    pairs,
  };
}
