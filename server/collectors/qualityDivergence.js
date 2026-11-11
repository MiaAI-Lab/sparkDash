/**
 * Quality bench, WP3: the Divergence category. 120 fixed generation prompts, greedy and seeded,
 * thinking off, replies stored in full, so two runs on the same unit and engine can be compared
 * reply by reply (identical share, first divergence, edit distance, length, long-generation drift,
 * loops, termination). Without a reference the structural checks stand on their own: loops,
 * termination, JSON validity and schema, tool-call correctness. Works on any OpenAI chat endpoint,
 * so it is the fallback where fidelity (prompt logprobs) is unsupported.
 *
 * Kinds: prose continuation (20), code (20), maths (20), instruction following (10), JSON (15),
 * tool calls (10), multilingual (10), multi-turn with a correction (10), long generation (5).
 *
 * Budgets leave room above the asked length (384 tokens for ~120 words, 2,048 for a ~1,000-word
 * essay): a reply cut off by the budget would read as a termination failure of the model.
 */

import { createHash } from "crypto";
import { fetch as undiciFetch } from "undici";
import { LLM_STREAM_AGENT, applyThinkingFlags, round2, thinkingOffFallbackBody } from "./LlmStreaming.js";
import { REQUEST_SEED, generateSuite, loadFidelityCorpus, mulberry32 } from "./qualitySuite.js";
import { detectLoop } from "../../src/shared/qualityDivergence.js";

/** Full reply kept per row (head); the long items are the only ones near it. */
export const DIVERGENCE_REPLY_CHARS = 12_000;
const pad2 = (n) => String(n).padStart(2, "0");

const CODE_TASKS = [
  ["sumEven", "(numbers)", "returns the sum of the even numbers in the array"],
  ["isPalindrome", "(text)", "returns true when the text reads the same backwards, ignoring case and spaces"],
  ["chunk", "(array, size)", "splits the array into consecutive chunks of the given size"],
  ["countWords", "(text)", "returns a map from each word to how many times it occurs"],
  ["debounce", "(fn, ms)", "returns a debounced version of fn that waits ms after the last call"],
  ["deepClone", "(value)", "returns a deep copy of plain objects and arrays"],
  ["flattenDepth", "(array, depth)", "flattens nested arrays up to the given depth"],
  ["formatBytes", "(n)", "formats a byte count as B, KB, MB or GB with one decimal"],
  ["groupBy", "(items, key)", "groups the items by the value of the given property"],
  ["lruCache", "(capacity)", "returns an object with get and set methods implementing an LRU cache"],
  ["mergeSorted", "(a, b)", "merges two sorted arrays into one sorted array"],
  ["parseQuery", "(url)", "returns the query-string parameters of the URL as an object"],
  ["retry", "(fn, attempts)", "calls the async fn up to attempts times until it resolves"],
  ["romanToInt", "(s)", "converts a Roman numeral string to an integer"],
  ["slugify", "(title)", "turns a title into a lowercase URL slug with hyphens"],
  ["topK", "(numbers, k)", "returns the k largest numbers in descending order"],
  ["uniqueBy", "(items, fn)", "removes items whose fn(item) was already seen"],
  ["wordWrap", "(text, width)", "wraps the text into lines no longer than width characters"],
  ["zip", "(a, b)", "returns an array of [a[i], b[i]] pairs"],
  ["binarySearch", "(sorted, target)", "returns the index of target in the sorted array or -1"],
];

const JSON_PERSONAS = [
  "a lighthouse keeper on a remote island", "a jazz pianist who teaches on weekends", "a marine biologist studying coral", "a retired train driver who collects maps",
  "a street-food cook famous for dumplings", "a glassblower in a mountain village", "a night-shift nurse who runs marathons", "a beekeeper who writes poetry",
  "a chess coach for children", "a cartographer of old cities", "a sound engineer for radio plays", "a florist who paints watercolours",
  "a ferry captain on a northern lake", "a librarian who restores old books", "a potter who fires wood kilns",
];

const TOOLS = {
  get_weather: {
    type: "function",
    function: {
      name: "get_weather",
      description: "Current weather for a city",
      parameters: { type: "object", properties: { city: { type: "string" }, unit: { type: "string", enum: ["celsius", "fahrenheit"] } }, required: ["city"] },
    },
  },
  convert_currency: {
    type: "function",
    function: {
      name: "convert_currency",
      description: "Convert an amount between currencies",
      parameters: { type: "object", properties: { amount: { type: "number" }, from: { type: "string" }, to: { type: "string" } }, required: ["amount", "from", "to"] },
    },
  },
  set_timer: {
    type: "function",
    function: { name: "set_timer", description: "Set a countdown timer", parameters: { type: "object", properties: { minutes: { type: "integer" }, label: { type: "string" } }, required: ["minutes"] } },
  },
  search_flights: {
    type: "function",
    function: {
      name: "search_flights",
      description: "Search flights between two airports on a date",
      parameters: { type: "object", properties: { from: { type: "string" }, to: { type: "string" }, date: { type: "string", description: "YYYY-MM-DD" } }, required: ["from", "to", "date"] },
    },
  },
  send_email: {
    type: "function",
    function: { name: "send_email", description: "Send an email", parameters: { type: "object", properties: { to: { type: "string" }, subject: { type: "string" }, body: { type: "string" } }, required: ["to", "subject"] } },
  },
};

const TOOL_TASKS = [
  ["What's the weather in Paris right now, in Celsius?", "get_weather", { city: "Paris", unit: "celsius" }],
  ["Convert 250 euros to Japanese yen.", "convert_currency", { amount: 250, from: "EUR", to: "JPY" }],
  ["Set a 15 minute timer for the pasta.", "set_timer", { minutes: 15 }],
  ["Find flights from JFK to LHR on 2026-12-24.", "search_flights", { from: "JFK", to: "LHR", date: "2026-12-24" }],
  ["Email ana@example.com with the subject 'Invoice 42' saying the payment went through.", "send_email", { to: "ana@example.com", subject: "Invoice 42" }],
  ["Is it warm in Tokyo today? Fahrenheit please.", "get_weather", { city: "Tokyo", unit: "fahrenheit" }],
  ["How much is 1200 US dollars in Swiss francs?", "convert_currency", { amount: 1200, from: "USD", to: "CHF" }],
  ["Start a 45 minute timer labelled laundry.", "set_timer", { minutes: 45, label: "laundry" }],
  ["Look for flights SFO to NRT on 2027-01-15.", "search_flights", { from: "SFO", to: "NRT", date: "2027-01-15" }],
  ["What's the weather like in Cape Town?", "get_weather", { city: "Cape Town" }],
];

const LANGUAGES = ["Chinese", "German", "French", "Spanish", "Japanese", "Italian", "Portuguese", "Korean", "Dutch", "Russian"];
const SENTENCES = [
  "The old bridge had carried the village's carts for two hundred years before the river changed its mind.",
  "Every morning the baker counted the swallows on the wire before he unlocked the door.",
  "Nobody remembered who had planted the fig tree in the courtyard, only that it fruited twice a year.",
  "The lighthouse went dark at midnight for the first time since the war.",
  "She kept the letters in a biscuit tin that smelled faintly of cinnamon.",
  "The last tram of the night always ran empty, and the driver sang to keep awake.",
  "A map of the city from 1911 still hung in the station, with streets that no longer existed.",
  "The children built a dam from pebbles and argued about the name of the lake it made.",
  "On the day the circus left, the field was full of ribbon and one forgotten shoe.",
  "The astronomer wrote her findings in pencil, because ink froze in the dome.",
];

const TURNS = [
  ["Give me a recipe for pancakes.", "Mix 1 cup flour, 1 cup milk, 1 egg, 1 tablespoon sugar and a pinch of salt; cook ladlefuls on a hot buttered pan until bubbles form, then flip.", "Actually I'm vegan — please redo it without eggs or dairy."],
  ["Write a haiku about rain.", "Soft rain on the roof / the kettle hums its one note / evening folds its hands", "I meant snow, not rain. Rewrite it."],
  ["Explain what a mutex is in two sentences.", "A mutex is a lock that lets only one thread hold a resource at a time. Others wait until it is released.", "Sorry, I meant a semaphore. Explain that instead, same length."],
  ["Suggest a name for a grey kitten.", "How about Pebble?", "It's actually a ginger kitten. Suggest three names that fit."],
  ["Convert 30 degrees Celsius to Fahrenheit.", "30 °C is 86 °F.", "I typed the wrong number — it was 38 °C. Redo it and show the formula."],
  ["List three uses for baking soda.", "Leavening in baking, deodorising a fridge, and gentle scouring of pans.", "I meant baking powder, not soda. Correct the list."],
  ["Write a two-line toast for a wedding.", "To the two of you: may your arguments be short and your dinners long. Cheers!", "It's for a retirement party, not a wedding — rewrite it for that."],
  ["What's the capital of Australia?", "Canberra.", "I actually meant Austria. Answer that, and give one fact about the city."],
  ["Summarise the plot of Cinderella in one sentence.", "A mistreated girl attends a royal ball with magical help, loses a slipper, and is found by the prince who marries her.", "I meant Snow White. Same length, please."],
  ["Give me a regular expression for a 5-digit US zip code.", "^\\d{5}$", "I need it to also allow the ZIP+4 form like 12345-6789. Update it."],
];

const ESSAYS = [
  "how railways changed the way cities grew in the nineteenth century",
  "why the tides exist and how they shape coastlines",
  "the history and craft of hand-made paper",
  "how honeybees organise a hive and why it matters for agriculture",
  "what makes a bridge stand up: forces, materials and famous failures",
];

/** Paragraphs of the corpus's prose documents that read as running text. */
function proseParagraphs() {
  const corpus = loadFidelityCorpus();
  const out = [];
  for (const doc of corpus.docs.filter((d) => d.kind === "prose")) {
    for (const para of doc.text.split(/\n\s*\n/)) {
      const p = para.trim();
      if (p.length < 260 || p.length > 900) continue;
      if (/^[#|>`\-*]/.test(p) || /\|/.test(p) || /```/.test(p) || /^\d+\./.test(p)) continue;
      out.push(p);
    }
  }
  return out;
}

/** @returns {Array<object>} the 120 items, deterministic */
export function divergenceItems() {
  const items = [];
  const rand = mulberry32(7331);
  const int = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));
  const push = (kind, i, fields) => items.push({ id: `div-${kind}-${pad2(i)}`, category: "divergence", kind, thinking: false, ...fields });

  const paras = proseParagraphs();
  for (let i = 1; i <= 20; i++) {
    const p = paras[(i * 7) % paras.length];
    push("prose", i, { maxTokens: 384, prompt: `Continue the following text in the same voice for about 120 words. Do not repeat it or comment on it.\n\n${p}` });
  }
  CODE_TASKS.forEach(([name, params, desc], i) => {
    push("code", i + 1, { maxTokens: 384, prompt: `Write a JavaScript function \`${name}${params}\` that ${desc}. Return only the code, no explanation.` });
  });
  const maths = generateSuite({ categories: ["arith", "reason"] });
  maths
    .filter((it) => it.category === "arith")
    .slice(0, 10)
    .forEach((it, i) => push("maths", i + 1, { maxTokens: 384, prompt: it.prompt, source: it.id }));
  maths
    .filter((it) => it.category === "reason")
    .slice(0, 10)
    .forEach((it, i) => push("maths", i + 11, { maxTokens: 384, prompt: it.prompt, source: it.id }));
  generateSuite({ categories: ["follow"] })
    .slice(0, 10)
    .forEach((it, i) => push("follow", i + 1, { maxTokens: 384, prompt: it.prompt, source: it.id }));
  JSON_PERSONAS.forEach((persona, i) => {
    const tags = int(2, 4);
    push("json", i + 1, {
      maxTokens: 192,
      schema: { name: "string", age: "integer", tags: `array:${tags}`, active: "boolean" },
      prompt: `Describe ${persona} as a JSON object and return only the JSON, with no prose and no code fence. Keys: "name" (string), "age" (integer), "tags" (array of exactly ${tags} short strings), "active" (boolean).`,
    });
  });
  TOOL_TASKS.forEach(([prompt, name, args], i) => {
    push("tool", i + 1, { maxTokens: 192, tools: [TOOLS[name], TOOLS[Object.keys(TOOLS)[(i + 1) % 5]]].filter((t, k, arr) => arr.indexOf(t) === k), expectTool: name, expectArgs: args, prompt });
  });
  LANGUAGES.forEach((lang, i) => {
    push("multi", i + 1, { maxTokens: 192, lang, prompt: `Translate the sentence below into ${lang}, then continue the story in ${lang} for two more sentences. Reply in ${lang} only.\n\n${SENTENCES[i]}` });
  });
  TURNS.forEach(([q, a, fix], i) => {
    push("turns", i + 1, { maxTokens: 384, messages: [{ role: "user", content: q }, { role: "assistant", content: a }, { role: "user", content: fix }], prompt: fix });
  });
  ESSAYS.forEach((topic, i) => {
    push("long", i + 1, { maxTokens: 2048, prompt: `Write a well-structured essay of about 1,000 words on ${topic}. Use short headings and finish with a one-paragraph conclusion.` });
  });
  return items;
}

/** Per-request timeout: 2 min plus 150 ms per allowed token. */
export function timeoutMsForDivergenceItem(item) {
  return 120_000 + (Number(item.maxTokens) || 0) * 150;
}

/** Strip a ```json fence the model added despite being told not to; the schema check still passes, the "fenced" flag says it happened. */
function parseJsonReply(text) {
  const raw = String(text ?? "").trim();
  const fenced = raw.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const body = fenced ? fenced[1] : raw;
  try {
    return { value: JSON.parse(body), fenced: Boolean(fenced) };
  } catch {
    return { value: undefined, fenced: Boolean(fenced) };
  }
}

/** @returns {{ valid: boolean, schema: boolean, fenced: boolean, missing: string[] }} */
export function checkJson(text, schema) {
  const { value, fenced } = parseJsonReply(text);
  if (value === undefined || value === null || typeof value !== "object" || Array.isArray(value)) return { valid: false, schema: false, fenced, missing: Object.keys(schema || {}) };
  const missing = [];
  for (const [key, type] of Object.entries(schema || {})) {
    const v = value[key];
    let ok;
    if (type === "string") ok = typeof v === "string" && v.length > 0;
    else if (type === "integer") ok = Number.isInteger(v);
    else if (type === "boolean") ok = typeof v === "boolean";
    else if (String(type).startsWith("array:")) {
      const n = Number(String(type).slice(6));
      ok = Array.isArray(v) && v.length === n && v.every((x) => typeof x === "string");
    } else ok = v !== undefined;
    if (!ok) missing.push(key);
  }
  return { valid: true, schema: missing.length === 0, fenced, missing };
}

/** @returns {{ called: boolean, nameOk: boolean, argsOk: boolean, name: string | null, wrong: string[] }} */
export function checkToolCall(toolCalls, expectTool, expectArgs) {
  const call = Array.isArray(toolCalls) ? toolCalls[0] : null;
  if (!call) return { called: false, nameOk: false, argsOk: false, name: null, wrong: Object.keys(expectArgs || {}) };
  const name = call.function?.name ?? call.name ?? null;
  let args = call.function?.arguments ?? call.arguments ?? null;
  if (typeof args === "string") {
    try {
      args = JSON.parse(args);
    } catch {
      args = null;
    }
  }
  const wrong = [];
  for (const [key, want] of Object.entries(expectArgs || {})) {
    const got = args?.[key];
    const same =
      typeof want === "number"
        ? Number(got) === want
        : typeof got === "string" && typeof want === "string"
          ? got.trim().toLowerCase() === want.toLowerCase()
          : got === want;
    if (!same) wrong.push(key);
  }
  return { called: true, nameOk: name === expectTool, argsOk: args != null && wrong.length === 0, name, wrong };
}

function hashOf(text) {
  return createHash("sha256").update(String(text ?? "")).digest("hex").slice(0, 16);
}

/**
 * One divergence item: a non-streamed chat completion (tool calls and finish reasons come back
 * whole), the structural checks, and the row with the full reply.
 */
export async function runDivergenceItem({ baseUrl, modelId, item, abortSignal = null, apiKey = null, fetchImpl = undiciFetch }) {
  const timeoutMs = timeoutMsForDivergenceItem(item);
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = abortSignal ? AbortSignal.any([abortSignal, timeout]) : timeout;
  /** @type {Record<string, string>} */
  const headers = { "Content-Type": "application/json", Accept: "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const base = {
    model: modelId || undefined,
    messages: item.messages || [{ role: "user", content: item.prompt }],
    max_tokens: item.maxTokens,
    temperature: 0,
    top_p: 1,
    seed: REQUEST_SEED,
    stream: false,
    ...(item.tools ? { tools: item.tools } : {}),
  };
  const body = applyThinkingFlags({ ...base }, modelId, false);
  const row = {
    id: item.id,
    category: "divergence",
    kind: item.kind,
    ok: false,
    excerpt: "",
    hash: "",
    finishReason: null,
    completionTokens: 0,
    promptTokens: 0,
    reasoningTokens: null,
    reasoningChars: 0,
    durationMs: 0,
    error: null,
    detail: null,
    thinking: false,
    chars: 0,
    terminated: false,
  };
  const t0 = performance.now();
  const post = async (b) => {
    const res = await fetchImpl(`${baseUrl}/v1/chat/completions`, { method: "POST", headers, body: JSON.stringify(b), signal, dispatcher: LLM_STREAM_AGENT });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    return { status: res.status, json, text: text.slice(0, 300) };
  };
  try {
    let r = await post(body);
    if (r.status === 400 && /think|chat_template|template/i.test(r.json?.error?.message || r.text || "")) r = await post(thinkingOffFallbackBody({ ...base }));
    row.durationMs = round2(performance.now() - t0);
    if (r.status !== 200) {
      row.error = `HTTP ${r.status}: ${r.json?.error?.message || r.text || "no body"}`;
      return row;
    }
    const choice = r.json?.choices?.[0];
    const msg = choice?.message || {};
    const content = typeof msg.content === "string" ? msg.content : Array.isArray(msg.content) ? msg.content.map((p) => p?.text || "").join("") : "";
    const reasoning = String(msg.reasoning_content ?? msg.reasoning ?? "");
    const toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
    const usage = r.json?.usage || {};
    row.finishReason = choice?.finish_reason || null;
    row.completionTokens = Number(usage.completion_tokens) || 0;
    row.promptTokens = Number(usage.prompt_tokens) || 0;
    const rt = Number(usage.completion_tokens_details?.reasoning_tokens);
    row.reasoningTokens = Number.isFinite(rt) ? rt : null;
    row.reasoningChars = reasoning.length;
    row.chars = content.length;
    row.reply = content.length > DIVERGENCE_REPLY_CHARS ? `${content.slice(0, DIVERGENCE_REPLY_CHARS)}…` : content;
    if (toolCalls.length) row.toolCalls = toolCalls.map((c) => ({ name: c.function?.name ?? c.name ?? null, arguments: typeof c.function?.arguments === "string" ? c.function.arguments.slice(0, 2000) : JSON.stringify(c.function?.arguments ?? c.arguments ?? null) }));
    row.hash = hashOf(content + (row.toolCalls ? JSON.stringify(row.toolCalls) : ""));
    row.terminated = row.finishReason === "stop" || row.finishReason === "tool_calls" || (row.finishReason == null && toolCalls.length > 0);
    row.loop = detectLoop(content);
    const notes = [];
    if (item.kind === "json") {
      row.json = checkJson(content, item.schema);
      row.ok = row.json.valid && row.json.schema;
      notes.push(row.json.valid ? (row.json.schema ? "valid JSON, schema ok" : `valid JSON, missing/wrong: ${row.json.missing.join(", ")}`) : "not JSON");
      if (row.json.fenced) notes.push("code-fenced");
    } else if (item.kind === "tool") {
      row.tool = checkToolCall(toolCalls, item.expectTool, item.expectArgs);
      row.ok = row.tool.nameOk && row.tool.argsOk;
      notes.push(!row.tool.called ? "no tool call" : row.tool.nameOk ? (row.tool.argsOk ? `called ${row.tool.name} correctly` : `called ${row.tool.name}, wrong: ${row.tool.wrong.join(", ")}`) : `called ${row.tool.name}, expected ${item.expectTool}`);
    } else {
      row.ok = row.terminated && !row.loop.loop;
      if (!row.terminated) notes.push(`finish ${row.finishReason ?? "unknown"}`);
    }
    if (row.loop.loop) notes.push(`loop: ${row.loop.cycle}-word cycle over ${Math.round(row.loop.tailShare * 100)}% of the reply`);
    notes.push(`${content.length.toLocaleString("en-US")} chars`);
    row.detail = notes.join(" · ");
    const flat = content.replace(/\s+/g, " ").trim();
    row.excerpt = flat ? (flat.length <= 160 ? flat : `${flat.slice(0, 160)}…`) : row.toolCalls ? `tool call ${row.toolCalls[0].name}(${row.toolCalls[0].arguments})`.slice(0, 160) : "(empty reply)";
    return row;
  } catch (err) {
    row.durationMs = round2(performance.now() - t0);
    row.error = timeout.aborted && !abortSignal?.aborted ? `Timed out after ${Math.round(timeoutMs / 1000)}s` : err?.message || String(err);
    return row;
  }
}
