/**
 * Quality bench, WP0: what the served engine is and what it can do, recorded on every run.
 *
 *  - `engineRecordFromModels` turns `/v1/models` (plus `/health` or `/version` where an engine has
 *    them) into a reproducibility record: checkpoint hash, quantisation, KV dtype, tensor-parallel
 *    size, speculative decoding, tokenizer identity, engine build.
 *  - `probePromptLogprobs` asks for prompt log-probabilities the way vLLM and TensorFold take them
 *    (non-streamed `/v1/completions`, `prompt_logprobs: K`) and reports what came back: never
 *    inferred from the engine's name, always measured.
 *  - `noiseSummary` compares the extra passes of a noise-floor run with the primary pass item by
 *    item, so run-to-run and batch (concurrency) noise is a number beside every score.
 *
 * Pure except for the two fetches; both take an injectable `fetchImpl` for tests.
 */

import { fetch as undiciFetch } from "undici";
import { LLM_STREAM_AGENT } from "./LlmStreaming.js";
import { engineRecordLine } from "../../src/shared/qualityBench.js";

const PROBE_TIMEOUT_MS = 20_000;
const PROBE_PROMPT = "The quick brown fox jumps over the lazy dog.";
/** Caps tried, highest first, after the K=1 shape probe; the first that answers is the recorded cap. */
const CAP_LADDER = [128, 20, 5];

/** owned_by values that name the engine itself (mirrors LlmProbe's set). */
const OWNED_BY_ENGINES = new Set([
  "locals", "splash", "tensorfold", "ds4", "sglang", "exl3", "q27", "freetoken", "radiance", "ninfer", "vllm",
]);

const num = (v) => (Number.isFinite(Number(v)) && v !== null && v !== "" ? Number(v) : null);
const str = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);

/**
 * @param {any} modelsJson the `/v1/models` body
 * @param {{ backend?: string | null, health?: any, version?: any, modelId?: string | null }} [extras]
 *   `health`: TensorFold's `/health` body; `version`: vLLM's `/version` body; `backend`: the probe's id.
 */
export function engineRecordFromModels(modelsJson, extras = {}) {
  const list = Array.isArray(modelsJson?.data) ? modelsJson.data : [];
  const wanted = str(extras.modelId);
  const m = (wanted && list.find((x) => x?.id === wanted)) || list[0] || null;
  const tf = m?.tensorfold && typeof m.tensorfold === "object" ? m.tensorfold : null;
  const owned = str(m?.owned_by);
  const backend =
    str(extras.backend) || (owned && OWNED_BY_ENGINES.has(owned.toLowerCase()) ? owned.toLowerCase() : null);
  const health = extras.health && typeof extras.health === "object" ? extras.health : null;
  const version = extras.version && typeof extras.version === "object" ? extras.version : null;
  const ctx = num(m?.max_model_len ?? m?.context_length ?? m?.meta?.n_ctx_train);
  /** @type {Record<string, any>} */
  const rec = {
    backend,
    modelId: str(m?.id),
    ownedBy: owned,
    engineVersion: str(tf?.engine_version) || str(health?.version) || str(version?.version) || null,
    gitCommit: str(tf?.git_commit) || null,
    patches: str(tf?.patches) || null,
    device: str(health?.device) || null,
    checkpoint: str(tf?.checkpoint) || null,
    checkpointSha256: str(tf?.checkpoint_sha256) || null,
    quantization: tf?.quantization && typeof tf.quantization === "object" ? { ...tf.quantization } : null,
    computeDtype: str(tf?.compute_dtype) || null,
    kvCacheDtype: str(tf?.kv_cache_dtype) || null,
    tensorParallel: num(tf?.tensor_parallel),
    contextLength: num(tf?.context) ?? ctx,
    speculative: tf?.speculative && typeof tf.speculative === "object" ? { ...tf.speculative } : null,
    tokenizerSha256: str(tf?.tokenizer_sha256) || null,
    tokenizerName: str(tf?.tokenizer_name) || null,
    promptBos: typeof tf?.prompt_bos === "boolean" ? tf.prompt_bos : null,
    promptLogprobsCap: num(tf?.prompt_logprobs_cap),
    reasoning: m?.reasoning && typeof m.reasoning === "object" ? { ...m.reasoning } : null,
  };
  // llama.cpp's model entry carries its own facts.
  if (m?.meta && typeof m.meta === "object") {
    rec.params = num(m.meta.n_params);
    rec.fileSizeBytes = num(m.meta.size);
  }
  return rec;
}

export { engineRecordLine };

async function postJson(fetchImpl, url, body, { apiKey = null, signal = null } = {}) {
  /** @type {Record<string, string>} */
  const headers = { "Content-Type": "application/json", Accept: "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const timeout = AbortSignal.timeout(PROBE_TIMEOUT_MS);
  const res = await fetchImpl(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    dispatcher: LLM_STREAM_AGENT,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: res.status, json, text: text.slice(0, 300) };
}

async function getJson(fetchImpl, url, { apiKey = null, signal = null } = {}) {
  /** @type {Record<string, string>} */
  const headers = { Accept: "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const timeout = AbortSignal.timeout(PROBE_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, {
      headers,
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      dispatcher: LLM_STREAM_AGENT,
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * Does the engine score a prompt's tokens (`prompt_logprobs`)? Measured, not assumed.
 * Shape "openai-completions": vLLM/TensorFold, position 0 null, then `{ id: { logprob, rank, decoded_token } }`.
 * @returns {Promise<object>} capability descriptor; `promptLogprobs` false carries `reason`.
 */
export async function probePromptLogprobs(baseUrl, modelId, { apiKey = null, signal = null, fetchImpl = undiciFetch, cap = null } = {}) {
  const body = (k) => ({
    model: modelId || undefined,
    prompt: PROBE_PROMPT,
    max_tokens: 1,
    temperature: 0,
    stream: false,
    prompt_logprobs: k,
  });
  const out = { promptLogprobs: false, shape: null, reason: null, probedAt: Date.now() };
  let first;
  try {
    first = await postJson(fetchImpl, `${baseUrl}/v1/completions`, body(1), { apiKey, signal });
  } catch (err) {
    out.reason = `completions request failed: ${err?.message || err}`;
    return out;
  }
  const choice = first.json?.choices?.[0];
  const rows = choice?.prompt_logprobs;
  if (first.status !== 200) {
    out.reason = `HTTP ${first.status}: ${first.json?.error?.message || first.text || "no body"}`;
    return out;
  }
  if (!Array.isArray(rows)) {
    out.reason = "no prompt_logprobs in the reply";
    return out;
  }
  const promptTokens = num(first.json?.usage?.prompt_tokens);
  let actualIncluded = false;
  let wellFormed = rows.length > 0;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (r == null) {
      if (i !== 0) wellFormed = false;
      continue;
    }
    if (typeof r !== "object" || Array.isArray(r)) {
      wellFormed = false;
      continue;
    }
    const entries = Object.values(r);
    if (!entries.every((e) => e && typeof e === "object" && Number.isFinite(Number(e.logprob)))) wellFormed = false;
    // K=1 plus the actual token: any row with two entries proves the actual token comes back even
    // outside the top-K.
    if (entries.length >= 2) actualIncluded = true;
  }
  if (!wellFormed) {
    out.reason = "prompt_logprobs rows are not in the vLLM shape";
    return out;
  }
  out.promptLogprobs = true;
  out.shape = "openai-completions";
  out.positions = rows.length;
  out.promptTokens = promptTokens;
  out.aligned = promptTokens != null ? rows.length === promptTokens : null;
  out.actualIncluded = actualIncluded;
  out.promptTokenIds = Array.isArray(choice?.prompt_token_ids);
  out.exactMode = str(first.json?.exact_mode);
  // The cap: trust an advertised one, else climb the ladder until a K answers.
  const advertised = num(cap);
  if (advertised != null && advertised >= 1) {
    out.cap = advertised;
    out.capSource = "advertised";
  } else {
    out.cap = 1;
    out.capSource = "probed";
    for (const k of CAP_LADDER) {
      try {
        const r = await postJson(fetchImpl, `${baseUrl}/v1/completions`, body(k), { apiKey, signal });
        const pl = r.json?.choices?.[0]?.prompt_logprobs;
        if (r.status === 200 && Array.isArray(pl) && pl.some((row) => row && Object.keys(row).length >= Math.min(k, 2))) {
          out.cap = k;
          break;
        }
      } catch {
        /* next rung */
      }
    }
  }
  return out;
}

/**
 * The whole WP0 descriptor for a run: the build record and the measured capabilities.
 * Never throws; a failed part is null with a reason.
 * @param {string} baseUrl
 * @param {{ modelId?: string | null, apiKey?: string | null, signal?: AbortSignal | null, backend?: string | null, fetchImpl?: Function, logprobs?: boolean }} [opts]
 */
export async function probeEngine(baseUrl, { modelId = null, apiKey = null, signal = null, backend = null, fetchImpl = undiciFetch, logprobs = true } = {}) {
  const key = apiKey != null && String(apiKey).trim() ? String(apiKey).trim() : null;
  const models = await getJson(fetchImpl, `${baseUrl}/v1/models`, { apiKey: key, signal });
  const first = Array.isArray(models?.data) ? models.data[0] : null;
  const owned = str(first?.owned_by)?.toLowerCase() || null;
  const kind = str(backend)?.toLowerCase() || owned;
  // Only the engines that have these endpoints are asked; the others would answer 404 or a web page.
  const health = kind === "tensorfold" ? await getJson(fetchImpl, `${baseUrl}/health`, { apiKey: key, signal }) : null;
  const version = kind === "vllm" ? await getJson(fetchImpl, `${baseUrl}/version`, { apiKey: key, signal }) : null;
  const record = engineRecordFromModels(models, { backend, health, version, modelId });
  let capabilities = null;
  if (logprobs && !signal?.aborted) {
    capabilities = await probePromptLogprobs(baseUrl, modelId || record.modelId, {
      apiKey: key,
      signal,
      fetchImpl,
      cap: record.promptLogprobsCap,
    });
  }
  return { record, capabilities, modelsReachable: models != null, probedAt: Date.now() };
}

/**
 * Noise floor: every extra pass paired with the primary pass by item id.
 * @param {object[]} primary the run's scored rows (pass 0)
 * @param {{ index: number, concurrency: number, kind: "repeat" | "serial", items: object[] }[]} passes
 * @param {number} primaryConcurrency
 */
export function noiseSummary(primary, passes, primaryConcurrency) {
  if (!Array.isArray(passes) || !passes.length) return null;
  const byId = new Map((primary || []).map((r) => [r.id, r]));
  const scored = (r) => r && !r.error && !r.disputed && !(r.ok === false && r.finishReason === "length");
  const out = { primaryConcurrency, passes: [] };
  for (const p of passes) {
    /** @type {Record<string, { pairs: number, discordant: number, identical: number, flipPct: number | null }>} */
    const categories = {};
    let pairs = 0;
    let discordant = 0;
    let identical = 0;
    for (const row of p.items || []) {
      const a = byId.get(row.id);
      if (!scored(a) || !scored(row)) continue;
      const c = categories[row.category] || (categories[row.category] = { pairs: 0, discordant: 0, identical: 0, flipPct: null });
      c.pairs += 1;
      pairs += 1;
      if (Boolean(a.ok) !== Boolean(row.ok)) {
        c.discordant += 1;
        discordant += 1;
      }
      if (a.hash && a.hash === row.hash) {
        c.identical += 1;
        identical += 1;
      }
    }
    for (const c of Object.values(categories)) c.flipPct = c.pairs ? Math.round((c.discordant / c.pairs) * 1000) / 10 : null;
    out.passes.push({
      index: p.index,
      kind: p.kind,
      concurrency: p.concurrency,
      pairs,
      discordant,
      identical,
      flipPct: pairs ? Math.round((discordant / pairs) * 1000) / 10 : null,
      identicalPct: pairs ? Math.round((identical / pairs) * 1000) / 10 : null,
      categories,
    });
  }
  const repeat = out.passes.filter((p) => p.kind === "repeat");
  const serial = out.passes.filter((p) => p.kind === "serial");
  const worst = (list) => (list.length ? Math.max(...list.map((p) => p.flipPct ?? 0)) : null);
  // The headline: the largest flip rate seen between runs that should be identical, and the batch
  // effect: how much the concurrency-1 passes differ from the primary (batched) pass.
  out.repeatFlipPct = worst(repeat);
  out.batchFlipPct = worst(serial);
  return out;
}

/**
 * WP1: was "thinking off" honoured? A thinking-off category whose replies carry reasoning (the
 * server counted reasoning tokens, or the stream had reasoning text) or that was cut off a lot is
 * flagged, so a run on a model that ignores the flag is not read as the model's quality. During a
 * run the rule waits for 10 rows of a category; at the end any size counts.
 * @param {Array<{ category: string, thinking?: boolean, reasoningTokens?: number | null, reasoningChars?: number, ok?: boolean, finishReason?: string | null, error?: string | null, disputed?: boolean }>} rows
 * @param {{ final?: boolean }} [opts]
 * @returns {Array<{ kind: "thinkingNotHonoured", category: string, rows: number, reasoningRows: number, truncated: number }>}
 */
export function thinkingWarnings(rows, { final = false } = {}) {
  /** @type {Record<string, { rows: number, reasoningRows: number, truncated: number }>} */
  const byCat = {};
  for (const r of rows || []) {
    if (r.thinking !== false || r.error) continue;
    const c = byCat[r.category] || (byCat[r.category] = { rows: 0, reasoningRows: 0, truncated: 0 });
    c.rows += 1;
    if ((Number(r.reasoningTokens) || 0) > 0 || (Number(r.reasoningChars) || 0) > 0) c.reasoningRows += 1;
    if (!r.ok && !r.disputed && r.finishReason === "length") c.truncated += 1;
  }
  const out = [];
  for (const [category, c] of Object.entries(byCat)) {
    if (!final && c.rows < 10) continue;
    if (c.reasoningRows / c.rows >= 0.1 || c.truncated / c.rows >= 0.2) {
      out.push({ kind: "thinkingNotHonoured", category, rows: c.rows, reasoningRows: c.reasoningRows, truncated: c.truncated });
    }
  }
  return out;
}

/** The passes a run makes: the primary, then the noise-floor extras when asked. */
export function planPasses(concurrency, noiseFloor) {
  const c = Math.max(1, Number(concurrency) || 1);
  const passes = [{ index: 0, kind: "primary", concurrency: c }];
  if (!noiseFloor) return passes;
  passes.push({ index: 1, kind: "repeat", concurrency: c });
  if (c > 1) {
    passes.push({ index: 2, kind: "serial", concurrency: 1 });
    passes.push({ index: 3, kind: "serial", concurrency: 1 });
  }
  return passes;
}
