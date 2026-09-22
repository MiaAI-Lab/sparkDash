/**
 * Shared LLM prompt catalogs (Showcase + Decode bench).
 * Structural = code/data formats; Text = prose (no code).
 */

export const TEXT_PROMPTS = [
  "Write a clear essay explaining unified memory on NVIDIA GB10 Sparks for a technical but non-specialist reader. Keep expanding with examples and analogies.",
  "Write a vivid sci-fi scene set in a liquid-cooled server room at 3 a.m. Keep expanding the scene with sensory detail and dialogue.",
  "Write a pirate-captain monologue explaining KV-cache pressure and prefill vs decode to the crew. Keep expanding with more shanties and metaphors.",
  "Write a nursery-rhyme style poem about thermal throttling and power caps. Add many stanzas and keep going.",
  "Write naturalistic dialogue between two ops engineers debugging a stuck vLLM queue. Continue for many turns without wrapping up.",
  "Write a courtroom cross-examination where the witness is a tokenizer. Keep adding Q&A exchanges.",
  "Write a travel-brochure parody for visiting a liquid-cooled GPU rack. Flowery marketing tone; keep expanding sections.",
  "Write a radio weather report for a GPU cluster: temperature fronts across racks, token-storm warnings. Keep broadcasting.",
  "Write packaging copy for a fictional energy drink called Prefill Punch aimed at LLM operators. Expand with flavors, warnings, and testimonials.",
  "Write chapter 1 of a short story titled \"The Day the Slots Went to Zero,\" then keep expanding the narrative without ending.",
  "Write a lecture transcript on TTFT, ITL, and e2e latency for inference operators. Keep teaching with more examples.",
  "Write a memoir-style recollection of the first time a cluster OOMed mid-demo. Keep expanding with flashbacks and lessons.",
  "Write a sports-commentator style play-by-play of concurrent decode waves hitting a 4-GPU node. Keep calling the action.",
  "Write a bedtime story for SREs about a friendly KV cache that grew too large. Keep adding chapters.",
  "Write an op-ed arguing that tok/s is overrated without TTFT context. Expand with rebuttals and counter-rebuttals.",
  "Write a campfire story told by a retired load balancer about the great token flood of '27. Keep going.",
];

export const STRUCTURAL_PROMPTS = [
  "Emit only a JSON array of fake GPU metrics rows. Each object needs host, gpuIndex, utilPct, tempC, powerW, memUsedMb. Invent many rows. No markdown. Keep expanding the array.",
  "Emit only an HTML FAQ about CUDA and vLLM. Use <h2> and <p> for many Q&A pairs. No markdown fences. Keep adding sections.",
  "Emit a Markdown comparison table: llama.cpp vs vLLM vs SGLang. Columns: feature, llama.cpp, vLLM, SGLang. Fill many rows and keep adding.",
  "Stream a fake syslog of cluster events (timestamps, INFO/WARN/ERROR, services). Keep lines coming continuously.",
  "Write only valid YAML for a multi-service docker-compose stack with redis, postgres, api, and worker. Expand heavily with env, volumes, and healthchecks.",
  "Emit a CSV of invented datacenter PUE readings: date,site,pue,itKw,facilityKw. Many rows. CSV only, no commentary. Keep adding rows.",
  "Generate a GraphQL schema as SDL only: types Query, Mutation, User, Job, Metric. Add many fields, enums, and interfaces. Keep expanding.",
  "Generate an OpenAPI 3 paths snippet as JSON for /v1/models and /v1/chat/completions. Expand schemas heavily. JSON only.",
  "Emit a Markdown cheatsheet: nvidia-smi flags vs what they show. Dense table, many rows. Keep adding.",
  "Generate a long TOML config for a fictional inference gateway: listeners, routes, retries, budgets. Keep expanding sections.",
  "Emit only SQL: CREATE TABLE + many INSERT statements for gpu_jobs(id, host, model, tokens, ms). Keep inserting.",
  "Generate a Mermaid sequenceDiagram (fenced) for client → proxy → vLLM → GPU. Expand with retries, queues, and metrics spans.",
  "Emit a long alphabetized Markdown definition list glossary of ML-systems jargon (KV cache, TTFT, ITL, MTP, …). Keep adding terms.",
  "Generate only Rust-flavored pseudocode for a lock-free token ring buffer. Keep expanding with more functions and tests.",
  "Emit a fake Prometheus text exposition dump for showcase_tokens_total, showcase_ttft_seconds, and related series. Keep adding metrics.",
  "Emit only a Python module of dataclasses for SparkHost, GpuSlice, and LlmEndpoint with typed fields, validators, and docstrings. Keep expanding.",
  "Write only valid JSON (no markdown). Generate OpenAPI-style paths as JSON: paths{}, components.schemas{}. Invent many endpoints and schemas.",
  "List 40 shell one-liners useful for NVIDIA Sparks / DGX. Commands only, one per line, no commentary. Then invent more variants.",
];

export const FILL_TO_MAX_SUFFIX =
  " Continue generating until you hit the maximum output length; do not stop early—keep expanding with more content.";

/** Same prompt as glm-5.3-flash-sm120 `tests/bench_decode.py --structured`. */
export const DECODE_STRUCTURED_PROMPT =
  "Count from 1 to 200. Output only the numbers, separated by spaces. No other text.";

/** Same prompt as glm-5.3-flash-sm120 `tests/bench_decode.py` default (hash-map prose). */
export const DECODE_PROSE_PROMPT =
  "Write a detailed step-by-step explanation of how a hash map works, " +
  "including collision handling, resizing, and time complexity. Be thorough.";

const CODE_TASK_TAIL =
  "Output only Python source. No comments, no docstrings, no markdown fences. " +
  "Then add tests and the helpers this needs. Keep writing code.";

/**
 * One real Python task per concurrent code stream. The name is the first line
 * so the prompts do not share a prefix-cache block. Same language and similar
 * length so a concurrency sweep compares batching, not unrelated workloads.
 * @param {string} name
 * @param {string} spec
 */
function codeTask(name, spec) {
  return `${name}\n${spec}\n${CODE_TASK_TAIL}`;
}

/** Distinct code workloads. C1 is the first; higher concurrency takes the next tasks. */
export const DECODE_CODE_TASKS = [
  codeTask("binary_search", "def binary_search(nums, target) -> int: index of target in a sorted list, or -1."),
  codeTask("merge_sort", "def merge_sort(nums) -> list: stable sort of a list of ints, returning a new list."),
  codeTask("lru_cache", "class LRUCache: get(key) and put(key, value) with a fixed capacity, evicting the least recently used."),
  codeTask("token_bucket", "class TokenBucket: allow(n) consumes n tokens refilled at a fixed rate, else returns False."),
  codeTask("ring_buffer", "class RingBuffer: push and pop over a fixed-capacity array, raising on overflow and underflow."),
  codeTask("dijkstra", "def dijkstra(graph, src) -> dict: shortest path weights from src on a non-negative weighted graph."),
  codeTask("edit_distance", "def edit_distance(a, b) -> int: Levenshtein distance between two strings."),
  codeTask("semver_cmp", "def semver_cmp(a, b) -> int: compare dotted numeric versions, negative if a < b."),
  codeTask("url_parse", "def url_parse(url) -> dict: scheme, host, port, path, and query pairs. No extra libraries."),
  codeTask("json_pointer", "def json_pointer(doc, pointer) -> object: follow an RFC 6901 pointer, or None if missing."),
  codeTask("glob_match", "def glob_match(pattern, text) -> bool: * and ? wildcards, no character classes."),
  codeTask("csv_parse", "def csv_parse(text) -> list: rows of fields, honoring double-quoted commas and escaped quotes."),
  codeTask("rle", "def rle_encode(s) -> str and rle_decode(s) -> str: run-length encoding of single-byte runs."),
  codeTask("top_k", "def top_k(nums, k) -> list: the k largest ints, unordered, using a bounded heap."),
  codeTask("interval_merge", "def merge_intervals(spans) -> list: merge overlapping [start, end] pairs."),
  codeTask("topo_sort", "def topo_sort(nodes, edges) -> list: a valid order, or None if the graph has a cycle."),
  codeTask("bloom_filter", "class BloomFilter: add(item) and might_contain(item) with two hash functions over a bit array."),
  codeTask("moving_average", "class MovingAverage: next(x) returns the mean of the last window values."),
  codeTask("retry_backoff", "def backoff_delays(attempts, base_ms, cap_ms) -> list: exponential delays clipped at the cap."),
  codeTask("base64_encode", "def b64_encode(data) -> str and b64_decode(text) -> bytes: standard base64, no libraries."),
  codeTask("expr_eval", "def eval_expr(text) -> int: evaluate non-negative ints with + - * / and parentheses."),
  codeTask("histogram_percentile", "def percentile(samples, p) -> float: nearest-rank percentile of a list of numbers."),
  codeTask("redact_secrets", "def redact(text) -> str: replace AWS-looking keys and password= values with ***. Keep the rest."),
  codeTask("chunk_text", "def chunk_text(text, size) -> list: split into chunks of at most size chars, breaking on spaces when possible."),
  codeTask("route_match", "def route_match(pattern, path) -> dict or None: /users/:id style params."),
  codeTask("crc32", "def crc32(data) -> int: IEEE CRC-32 of a bytes object."),
  codeTask("fixed_window", "class FixedWindow: allow() is True up to limit events per window_s, else False."),
  codeTask("diff_lines", "def diff_lines(a, b) -> list: line diff as equal/delete/insert ops using a simple LCS."),
  codeTask("infix_postfix", "def infix_to_postfix(tokens) -> list: shunting-yard for + - * / and parentheses."),
  codeTask("consistent_hash", "class ConsistentHash: add_node, remove_node, and get_node(key) on a ring of virtual nodes."),
  codeTask("utf8_decode", "def utf8_decode(data) -> str: decode UTF-8 bytes, replacing invalid sequences with U+FFFD."),
  codeTask("dependency_closure", "def closure(root, deps) -> list: packages reachable from root, each name once, in visit order."),
];

/** C1 code prompt. Concurrent waves use the rest of DECODE_CODE_TASKS. */
export const DECODE_CODE_PROMPT = DECODE_CODE_TASKS[0];

/**
 * JIT warmup for the code type. Not one of the measured tasks, so a concurrent
 * wave does not inherit a prefix-cache hit on stream 1.
 */
export const DECODE_CODE_WARMUP_PROMPT = codeTask(
  "warmup_noop",
  "def warmup_noop(x): return x unchanged."
);

/**
 * JSON/YAML-ish catalog (Showcase structural #0). Labels an output shape only —
 * do not send response_format / grammars / guided JSON with this prompt.
 */
export const DECODE_JSON_PROMPT = STRUCTURAL_PROMPTS[0];

/** Decode-bench output types (not guided decoding). Structured is the default. */
export const DECODE_BENCH_TYPES = ["structured", "prose", "code", "json"];
export const DECODE_BENCH_DEFAULT_TYPE = "structured";

export const DECODE_BENCH_PROMPTS = {
  structured: DECODE_STRUCTURED_PROMPT,
  prose: DECODE_PROSE_PROMPT,
  code: DECODE_CODE_PROMPT,
  json: DECODE_JSON_PROMPT,
};

export const DECODE_BENCH_TYPE_META = [
  {
    id: "structured",
    label: "Structured",
    hint: "Count 1→200, numbers only — lab structured protocol",
  },
  {
    id: "prose",
    label: "Prose",
    hint: "Hash-map explanation — lab default bench prompt",
  },
  {
    id: "code",
    label: "Code",
    hint: "Distinct Python tasks per stream — different prefixes, no comments",
  },
  {
    id: "json",
    label: "JSON",
    hint: "JSON GPU-metrics catalog — output type only, not guided JSON",
  },
];

/**
 * @param {unknown} type
 * @returns {"structured" | "prose" | "code" | "json"}
 */
export function normalizeDecodeBenchType(type) {
  const t = String(type || "").trim().toLowerCase();
  return DECODE_BENCH_TYPES.includes(t) ? t : DECODE_BENCH_DEFAULT_TYPE;
}

/**
 * @param {unknown} type
 * @returns {string}
 */
export function decodeBenchPromptForType(type) {
  return DECODE_BENCH_PROMPTS[normalizeDecodeBenchType(type)];
}

/**
 * @param {unknown} type
 * @returns {string}
 */
export function decodeBenchTypeLabel(type) {
  const id = normalizeDecodeBenchType(type);
  return DECODE_BENCH_TYPE_META.find((m) => m.id === id)?.label || "Structured";
}

/**
 * Append a hard fill-to-max instruction unless the prompt already states it.
 * Soft phrases like "keep expanding" alone do not skip — models still EOS early.
 * @param {string} prompt
 */
export function withFillToMaxInstruction(prompt) {
  const p = String(prompt || "").trim();
  if (!p) return p;
  if (
    /maximum output length|do not stop early|until you hit the (maximum|output)/i.test(
      p
    )
  ) {
    return p;
  }
  return `${p}${FILL_TO_MAX_SUFFIX}`;
}

/**
 * Build N prompts for a prompt type. Mixed interleaves structural then text.
 * @param {"structural" | "text" | "mixed"} type
 * @param {number} count
 * @returns {string[]}
 */
export function pickShowcasePrompts(type, count) {
  const n = Math.max(1, Math.floor(count));
  if (type === "text") return takeCycled(TEXT_PROMPTS, n);
  if (type === "structural") return takeCycled(STRUCTURAL_PROMPTS, n);

  const out = [];
  let si = 0;
  let ti = 0;
  for (let i = 0; i < n; i++) {
    if (i % 2 === 0) {
      out.push(STRUCTURAL_PROMPTS[si % STRUCTURAL_PROMPTS.length]);
      si += 1;
    } else {
      out.push(TEXT_PROMPTS[ti % TEXT_PROMPTS.length]);
      ti += 1;
    }
  }
  return out;
}

/**
 * Concurrent code streams are different tasks, each starting with its own name
 * so they do not share a prefix. Past the catalog, a leading stream id keeps
 * the next copy from matching the first.
 * @param {number} n
 * @returns {string[]}
 */
function pickDecodeCodePrompts(n) {
  const out = [];
  const size = DECODE_CODE_TASKS.length;
  for (let i = 0; i < n; i++) {
    const task = DECODE_CODE_TASKS[i % size];
    const cycle = Math.floor(i / size);
    out.push(cycle === 0 ? task : `[stream ${i + 1}]\n${task}`);
  }
  return out;
}

/**
 * Decode-bench prompts for a workload type. Code uses one real task per stream.
 * Other types share one prompt; concurrent streams get a unique suffix so they
 * do not share a prefix-cache block. C1 is the exact prompt.
 * @param {number} count
 * @param {unknown} [type]
 * @returns {string[]}
 */
export function pickDecodeBenchPrompts(count, type) {
  const n = Math.max(1, Math.floor(count));
  if (normalizeDecodeBenchType(type) === "code") return pickDecodeCodePrompts(n);
  const base = decodeBenchPromptForType(type);
  if (n <= 1) return [base];
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push(`${base} (stream ${i + 1}/${n})`);
  }
  return out;
}

/**
 * @param {string[]} pool
 * @param {number} n
 */
function takeCycled(pool, n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(pool[i % pool.length]);
  return out;
}
