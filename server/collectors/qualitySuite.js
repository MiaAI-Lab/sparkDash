/**
 * Quality-bench suite — deterministic item generation + scoring (pure, no I/O).
 *
 * Every category draws from its own seeded PRNG (mulberry32), so items and ids
 * are identical on every run and two runs can be paired item-by-item. Changing
 * one category's generator never shifts another category's items.
 *
 * Item shape (common): { id, category, prompt?, maxTokens, thinking }.
 * Long-context prompts are large, so those items carry a seed and the prompt is
 * rebuilt on demand with buildLongPrompt(item).
 */

import { readFileSync } from "node:fs";
import { QUALITY_CATEGORIES } from "../../src/shared/qualityBench.js";
import { qualityLongFitsContext } from "../../src/shared/contextFit.js";

/** Item generation (prompts, ids, seeds). Bump when the item set changes. */
export const SUITE_VERSION = 1;
/**
 * Scoring rules (parsers, QA modes). Bump whenever a change could flip an item's pass/fail for the
 * same reply; stored in each run's config so compareQualityRuns can refuse to pair runs scored by
 * different rules.
 *   1: original parsers
 *   2: strict QA 'last number' (no lead-with-answer fallback), negation-aware word mode,
 *      case-insensitive / suffix-tolerant Answer parsing (MMLU, GSM8K/arith/track)
 */
export const SCORING_VERSION = 2;
/** Fixed `seed` field sent with every request (servers that honour it stay reproducible). */
export const REQUEST_SEED = 1234;

const QA_MIN_TOKENS = 64;
const REASON_MAX_TOKENS = 8192;
const CHAIN_MAX_TOKENS = 12288;
const LONG_MAX_TOKENS = 512;

// ─── PRNG ────────────────────────────────────────────────

/** @param {number} seed */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a 32-bit — stable per-category / per-item seeds. */
export function hashString(s) {
  let h = 0x811c9dc5;
  const str = String(s);
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function rngFor(key) {
  return mulberry32(hashString(`sparkdash-quality-v${SUITE_VERSION}:${key}`));
}

/** Inclusive integer in [lo, hi]. */
function randint(rng, lo, hi) {
  return lo + Math.floor(rng() * (hi - lo + 1));
}

function pick(rng, list) {
  return list[Math.floor(rng() * list.length)];
}

function shuffled(rng, list) {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function commafy(n) {
  return Number(n).toLocaleString("en-US");
}

function uniq(list) {
  return [...new Set(list)];
}

// ─── QA ──────────────────────────────────────────────────

/** [question, accepted answers, max_tokens] */
const QA_FIXED = [
  ["What is 17 * 23? Answer with the number only.", ["391"], 16],
  ["What is 1234 + 8766? Answer with the number only.", ["10000"], 16],
  ["What is 2 to the power of 20? Answer with the number only.", ["1048576", "1,048,576"], 16],
  ["A train travels 180 km in 2.5 hours. What is its average speed in km/h? Number only.", ["72"], 16],
  ["If x + 2x + 3x = 48, what is x? Number only.", ["8"], 16],
  ["What is the remainder when 1000 is divided by 7? Number only.", ["6"], 16],
  ["How many minutes are in 3.5 hours? Number only.", ["210"], 16],
  ["What is the square root of 1764? Number only.", ["42"], 16],
  ["What is 15% of 240? Number only.", ["36"], 16],
  ["A rectangle is 12 by 7. What is its area? Number only.", ["84"], 16],
  ["Reverse the string 'tensorfold'. Answer with the reversed string only.", ["dlofrosnet"], 16],
  ["How many letters 'r' are in the word 'strawberry'? Number only.", ["3"], 16],
  ["Sort these numbers ascending: 9, 2, 7, 4, 1. Answer as a comma-separated list.", ["1, 2, 4, 7, 9", "1,2,4,7,9"], 24],
  ["What comes next: 2, 6, 12, 20, 30, ? Number only.", ["42"], 16],
  ["All bloops are razzies and all razzies are lazzies. Are all bloops lazzies? Answer yes or no.", ["yes"], 8],
  ["If today is Wednesday, what day is it 10 days from now? One word.", ["saturday"], 8],
  ["What is the capital of Australia? One word.", ["canberra"], 8],
  ["What is the chemical symbol for gold? Symbol only.", ["au"], 8],
  ["Who wrote 'Pride and Prejudice'? Name only.", ["austen"], 12],
  ["What is the boiling point of water at sea level in degrees Celsius? Number only.", ["100"], 8],
  ["How many sides does a hexagon have? Number only.", ["6"], 8],
  ["What is the largest planet in our solar system? One word.", ["jupiter"], 8],
  ["In Python, what does len([1, [2, 3], 4]) return? Number only.", ["3"], 8],
  ["In Python, what is the value of 7 // 2? Number only.", ["3"], 8],
  ["What is the binary representation of 13? Digits only.", ["1101"], 12],
  ["What is 0.1 + 0.2 rounded to one decimal place? Number only.", ["0.3"], 8],
  ["Convert 5 kilometers to meters. Number only.", ["5000", "5,000"], 12],
  ["What is the greatest common divisor of 84 and 36? Number only.", ["12"], 8],
  ["Spell the word 'necessary' backwards. Letters only.", ["yrassecen"], 16],
  ["What is 999 * 999? Number only.", ["998001", "998,001"], 16],
];

const COUNT_WORDS = [
  "mississippi", "bookkeeper", "banana", "committee", "parallel", "assessment",
  "successful", "occurrence", "tattoo", "referee", "balloon", "coffee", "letter",
  "address", "giraffe",
];

function gcd(a, b) {
  while (b) [a, b] = [b, a % b];
  return a;
}

/** How a QA reply is judged, from the shape of the accepted answer. */
function qaModeFor(accept) {
  const a = String(accept[0]);
  if (/^-?[\d,]*\.?\d+$/.test(a)) return "number";
  if (/^\d+\s*,\s*\d+(\s*,\s*\d+)*$/.test(a)) return "list";
  return "word";
}

function qaItem(id, prompt, accept, mode = null, maxTokens = QA_MIN_TOKENS) {
  mode = mode && mode !== "substring" ? mode : qaModeFor(accept);
  return {
    id,
    category: "qa",
    prompt,
    accept: uniq(accept),
    mode,
    maxTokens: Math.max(maxTokens, QA_MIN_TOKENS),
    thinking: false,
  };
}

function genQa() {
  const items = QA_FIXED.map(([q, accept, max], i) =>
    qaItem(`qa-fixed-${pad2(i + 1)}`, q, accept, null, max)
  );
  const rng = rngFor("qa");

  for (let i = 1; i <= 20; i++) {
    const a = randint(rng, 100, 999);
    const b = randint(rng, 10, 99);
    const p = a * b;
    items.push(qaItem(`qa-mul-${pad2(i)}`, `What is ${a} * ${b}? Answer with the number only.`, [String(p), commafy(p)]));
  }
  for (let i = 1; i <= 15; i++) {
    const a = randint(rng, 1000, 9999);
    const b = randint(rng, 1000, 9999);
    const c = randint(rng, 1000, 9999);
    const r = a + b - c;
    items.push(qaItem(`qa-addsub-${pad2(i)}`, `What is ${a} + ${b} - ${c}? Answer with the number only.`, [String(r), commafy(r)]));
  }
  for (let i = 1; i <= 15; i++) {
    const len = randint(rng, 6, 10);
    let s = "";
    for (let j = 0; j < len; j++) s += String.fromCharCode(97 + randint(rng, 0, 25));
    const rev = [...s].reverse().join("");
    items.push(qaItem(`qa-rev-${pad2(i)}`, `Reverse the string '${s}'. Answer with the reversed string only.`, [rev]));
  }
  for (let i = 1; i <= 15; i++) {
    const w = COUNT_WORDS[i - 1];
    const ch = pick(rng, [...w]);
    const n = [...w].filter((x) => x === ch).length;
    items.push(
      qaItem(`qa-count-${pad2(i)}`, `How many times does the letter '${ch}' appear in the word '${w}'? Number only.`, [String(n)])
    );
  }
  for (let i = 1; i <= 15; i++) {
    const nums = [];
    while (nums.length < 7) {
      const n = randint(rng, 1, 99);
      if (!nums.includes(n)) nums.push(n);
    }
    const sorted = [...nums].sort((x, y) => x - y);
    items.push(
      qaItem(`qa-sort-${pad2(i)}`, `Sort these numbers ascending: ${nums.join(", ")}. Answer as a comma-separated list.`, [
        sorted.join(", "),
        sorted.join(","),
      ])
    );
  }
  const usedBin = new Set();
  for (let i = 1; i <= 10; i++) {
    let n = randint(rng, 20, 255);
    while (usedBin.has(n)) n = randint(rng, 20, 255);
    usedBin.add(n);
    items.push(qaItem(`qa-bin-${pad2(i)}`, `What is the binary representation of ${n}? Digits only.`, [n.toString(2)]));
  }
  const base = Date.UTC(2020, 0, 1);
  const span = Math.round((Date.UTC(2030, 11, 31) - base) / 86_400_000);
  for (let i = 1; i <= 15; i++) {
    const d0 = new Date(base + randint(rng, 0, span) * 86_400_000);
    const k = randint(rng, 3, 60);
    const d1 = new Date(d0.getTime() + k * 86_400_000);
    const iso = (d) => d.toISOString().slice(0, 10);
    items.push(
      qaItem(`qa-date-${pad2(i)}`, `What date is ${k} days after ${iso(d0)}? Answer in YYYY-MM-DD format only.`, [iso(d1)], "date")
    );
  }
  for (let i = 1; i <= 15; i++) {
    const a = randint(rng, 2, 30);
    const b = randint(rng, 2, 30);
    const l = (a * b) / gcd(a, b);
    items.push(qaItem(`qa-lcm-${pad2(i)}`, `What is the least common multiple of ${a} and ${b}? Number only.`, [String(l)]));
  }
  return items;
}

// ─── Reason (word problems, thinking on) ─────────────────

const REASON_NAMES = [
  "Alice", "Bruno", "Carmen", "Dmitri", "Elena", "Farid", "Grace", "Hiro",
  "Ines", "Jamal", "Keiko", "Liam", "Maya", "Noah", "Olga", "Pedro",
];
const REASON_THINGS = [
  "apples", "marbles", "stickers", "coins", "pencils", "cards", "shells", "stamps", "beads", "buttons",
];

function genReason() {
  const rng = rngFor("reason");
  const items = [];
  for (let i = 1; i <= 40; i++) {
    const [A, B, C] = shuffled(rng, REASON_NAMES).slice(0, 3);
    const things = pick(rng, REASON_THINGS);
    const x = randint(rng, 20, 90);
    const k = randint(rng, 2, 5);
    const g = randint(rng, 3, 15);
    const c = randint(rng, 5, 40);
    const h = randint(rng, 2, Math.floor(x / 2));
    const p = pick(rng, [2, 3, 4]);
    const total = x - h + (k * x - g) + 2 * (c + g);
    const prompt =
      `${A} has ${x} ${things}. ${B} has ${k} times as many ${things} as ${A}. ${C} has ${c} ${things}. ` +
      `${B} gives ${g} ${things} to ${C}. Then ${A} loses ${h} ${things}, and ${C} doubles the number of ${things} they have. ` +
      `Then all three put their ${things} together and split them as evenly as possible into ${p} boxes, ` +
      `putting any leftover ${things} in a jar. How many ${things} are in the jar, and how many are in each box? ` +
      `End your reply with a line 'Answer: <jar>, <per box>'.`;
    items.push({
      id: `reason-${pad2(i)}`,
      category: "reason",
      prompt,
      expected: { jar: total % p, box: Math.floor(total / p) },
      maxTokens: REASON_MAX_TOKENS,
      thinking: true,
    });
  }
  return items;
}

// ─── Follow (verifiable instruction following, thinking off) ─────

const FOLLOW_MAX_TOKENS = 1024;
const FOLLOW_TOPICS = [
  "the benefits of walking to work",
  "how a library organises its books",
  "why the sea is salty",
  "a day in the life of a lighthouse keeper",
  "how to brew a good cup of tea",
  "the history of the bicycle",
  "why sleep matters for students",
  "how bees make honey",
  "what makes a city park pleasant",
  "the first week at a new job",
  "how to repair a flat bike tyre",
  "why people collect stamps",
  "the life cycle of a butterfly",
  "how a train timetable is planned",
  "tips for learning a musical instrument",
  "why bread rises in the oven",
  "the role of a village market",
  "how to plan a small vegetable garden",
  "what a lighthouse lamp does at night",
  "how rivers shape valleys",
];
const FOLLOW_KEYWORDS = ["river", "garden", "window", "balance", "pattern", "journey", "signal", "harbor", "lantern", "compass"];
const FOLLOW_FORBIDDEN = ["very", "really", "thing", "good", "just", "also"];
const FOLLOW_ENDINGS = ["Is there anything else I can help with?", "That is all for now.", "Thank you for reading."];

// Markdown markers ("*", "***", "<<T>>" on its own) are not words: only tokens with a letter or digit count.
const wordsOf = (t) => t.trim().split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w));
// Word boundary that treats "_" as punctuation, so _garden_ still counts as garden.
const wordRe = (w, flags = "i") =>
  new RegExp(`(?<![\\p{L}\\p{N}])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}])`, flags + "u");

/**
 * Rules are plain data (so a checkpointed job survives a JSON round trip); `followCheck`
 * turns one into a pass/fail on the visible reply. An item draws one rule from each of
 * 2-3 groups, and the groups below never contradict each other.
 */
const FOLLOW_GROUPS = {
  length: [
    (rng) => {
      const n = pick(rng, [60, 80, 100]);
      return { kind: "min-words", n, text: `Use at least ${n} words.` };
    },
    (rng) => {
      const n = pick(rng, [30, 40, 50]);
      return { kind: "max-words", n, text: `Use fewer than ${n} words.` };
    },
  ],
  layout: [
    (rng) => {
      const n = pick(rng, [3, 4, 5]);
      return { kind: "bullets", n, text: `Use exactly ${n} bullet points, each starting with "* ", and no other lists.` };
    },
    (rng) => {
      const n = pick(rng, [2, 3, 4]);
      return { kind: "paragraphs", n, text: `Write exactly ${n} paragraphs separated by a line containing only ***.` };
    },
    () => ({ kind: "quoted", text: "Wrap your entire reply in double quotation marks." }),
    () => ({ kind: "title", text: "Include a title wrapped in double angular brackets, like <<title>>." }),
  ],
  words: [
    (rng) => {
      const w = shuffled(rng, FOLLOW_KEYWORDS).slice(0, 2);
      return { kind: "include", w, text: `Include the words "${w[0]}" and "${w[1]}" at least once each.` };
    },
    (rng) => {
      const w = pick(rng, FOLLOW_KEYWORDS);
      const n = pick(rng, [2, 3]);
      return { kind: "repeat", w, n, text: `Use the word "${w}" at least ${n} times.` };
    },
    (rng) => {
      const w = shuffled(rng, FOLLOW_FORBIDDEN).slice(0, 2);
      return { kind: "forbid", w, text: `Do not use the words "${w[0]}" or "${w[1]}" anywhere.` };
    },
    () => ({ kind: "no-commas", text: "Do not use any commas." }),
  ],
  ending: [
    (rng) => {
      const e = pick(rng, FOLLOW_ENDINGS);
      return { kind: "ends-with", e, text: `Finish with this exact phrase and nothing after it: ${e}` };
    },
    () => ({ kind: "postscript", text: 'End with a postscript that starts with "P.S."' }),
  ],
};
/** A casing rule is added on its own (it is the one that can clash with keywords and fixed endings). */
const FOLLOW_CASE = [
  { kind: "lowercase", text: "Write the whole reply in lowercase letters only, with no capital letters at all." },
  { kind: "uppercase", text: "Write the whole reply in CAPITAL LETTERS only, with no lowercase letters at all." },
];

export function followCheck(rule, t) {
  switch (rule.kind) {
    case "min-words":
      return wordsOf(t).length >= rule.n;
    case "max-words":
      return wordsOf(t).length < rule.n;
    case "bullets":
      return t.split(/\r?\n/).filter((l) => /^\s*\*\s/.test(l)).length === rule.n && !/^\s*\d+[.)]\s/m.test(t);
    case "paragraphs": {
      const parts = t.split(/\r?\n\s*\*{3}\s*\r?\n/).map((x) => x.trim());
      return parts.length === rule.n && parts.every(Boolean);
    }
    case "quoted":
      return t.trim().length > 2 && t.trim().startsWith('"') && t.trim().endsWith('"');
    case "title":
      return /<<[^<>\n]+>>/.test(t);
    case "include":
      return rule.w.every((w) => wordRe(w).test(t));
    case "repeat":
      return (t.match(wordRe(rule.w, "gi")) || []).length >= rule.n;
    case "forbid":
      return !rule.w.some((w) => wordRe(w).test(t));
    case "no-commas":
      return !t.includes(",");
    case "ends-with":
      return t.trim().endsWith(rule.e);
    case "postscript":
      return /(^|\n)\s*P\.S\./.test(t);
    case "lowercase":
      return t === t.toLowerCase();
    case "uppercase":
      return t === t.toUpperCase();
    default:
      return false;
  }
}

function genFollow() {
  const rng = rngFor("follow");
  const groupNames = Object.keys(FOLLOW_GROUPS);
  const items = [];
  for (let i = 1; i <= 40; i++) {
    const topic = pick(rng, FOLLOW_TOPICS);
    const chosen = shuffled(rng, groupNames).slice(0, i % 3 === 0 ? 3 : 2);
    const rules = chosen.map((g) => pick(rng, FOLLOW_GROUPS[g])(rng));
    // "Wrap everything in quotes" and "end with this exact phrase" cannot both hold (the closing quote
    // would follow the phrase). Swap the quote rule for a title rule; no random draw, so other items stay put.
    if (rules.some((r) => r.kind === "quoted") && rules.some((r) => r.kind === "ends-with")) {
      const i = rules.findIndex((r) => r.kind === "quoted");
      rules[i] = { kind: "title", text: "Include a title wrapped in double angular brackets, like <<title>>." };
    }
    // Every 4th item adds a casing rule, but never beside a rule whose own text needs mixed case
    // (fixed endings, "P.S.", keywords, a title) or that the model may answer in quotes of its own.
    if (i % 4 === 0 && !chosen.includes("ending") && !rules.some((r) => r.kind === "include" || r.kind === "repeat" || r.kind === "title")) {
      rules.push(pick(rng, FOLLOW_CASE));
    }
    const prompt = `Write a short piece about ${topic}. Follow every rule below exactly.\n` + rules.map((r, n) => `${n + 1}. ${r.text}`).join("\n");
    items.push({ id: `follow-${pad2(i)}`, category: "follow", prompt, rules, maxTokens: FOLLOW_MAX_TOKENS, thinking: false });
  }
  return items;
}

// ─── Arith (10-step chain, thinking on) ──────────────────

function genArith() {
  const rng = rngFor("arith");
  const items = [];
  const ops = ["mul", "add", "sub", "mod", "div"];
  for (let i = 1; i <= 40; i++) {
    const v0 = randint(rng, 100, 999);
    let v = v0;
    const steps = [];
    for (let s = 1; s <= 10; s++) {
      const op = pick(rng, ops);
      let text;
      if (op === "mul") {
        const k = randint(rng, 3, 19);
        v *= k;
        text = `multiply it by ${k}`;
      } else if (op === "add") {
        const k = randint(rng, 100, 9999);
        v += k;
        text = `add ${k}`;
      } else if (op === "sub") {
        const k = randint(rng, 10, Math.max(11, Math.floor(v / 2)));
        v -= k;
        text = `subtract ${k}`;
      } else if (op === "mod") {
        const k = randint(rng, 1000, 9999);
        v = (v % k) + 1000;
        text = `replace it by its remainder when divided by ${k}, then add 1000`;
      } else {
        const k = randint(rng, 2, 9);
        v = Math.floor(v / k);
        text = `divide it by ${k}, rounding down`;
      }
      if (!Number.isSafeInteger(v)) {
        throw new Error(`arith-${pad2(i)}: value left the safe-integer range`);
      }
      steps.push(`(${s}) ${text}`);
    }
    items.push({
      id: `arith-${pad2(i)}`,
      category: "arith",
      prompt: `Start with ${v0}. Then, in order: ${steps.join("; ")}. What is the final number? End your reply with a line 'Answer: <number>'.`,
      expected: v,
      maxTokens: CHAIN_MAX_TOKENS,
      thinking: true,
    });
  }
  return items;
}

// ─── Track (token transfers, thinking on) ────────────────

const TRACK_PEOPLE = ["Ana", "Bo", "Cy", "Di", "Ed"];

function genTrack() {
  const rng = rngFor("track");
  const items = [];
  for (let i = 1; i <= 40; i++) {
    /** @type {Record<string, number>} */
    const have = {};
    const sentences = [];
    for (const p of TRACK_PEOPLE) {
      have[p] = randint(rng, 20, 60);
      sentences.push(`${p} starts with ${have[p]} tokens.`);
    }
    for (let e = 0; e < 25; e++) {
      const a = pick(rng, TRACK_PEOPLE);
      let b = pick(rng, TRACK_PEOPLE);
      while (b === a) b = pick(rng, TRACK_PEOPLE);
      const r = rng();
      if (r < 0.6 && have[a] > 0) {
        const k = randint(rng, 1, Math.max(1, Math.floor(have[a] / 2)));
        have[a] -= k;
        have[b] += k;
        sentences.push(`${a} gives ${k} to ${b}.`);
      } else if (r < 0.8) {
        const k = randint(rng, 1, 9);
        have[a] += k;
        sentences.push(`${a} finds ${k}.`);
      } else {
        const g = Math.floor(have[a] / 2);
        have[a] -= g;
        have[b] += g;
        sentences.push(`${a} gives half of their tokens (rounded down) to ${b}.`);
      }
    }
    const who = pick(rng, TRACK_PEOPLE);
    items.push({
      id: `track-${pad2(i)}`,
      category: "track",
      prompt:
        `Track the tokens carefully. ${sentences.join(" ")} How many tokens does ${who} have at the end? ` +
        `End your reply with a line 'Answer: <number>'.`,
      expected: have[who],
      maxTokens: CHAIN_MAX_TOKENS,
      thinking: true,
    });
  }
  return items;
}

// ─── GSM8K + MMLU (published datasets, fixed seeded subsets) ─────
//
// GSM8K (grade-school maths, Cobbe et al. 2021) and MMLU (57-subject multiple choice,
// Hendrycks et al. 2021) are both MIT-licensed. The bundled files are fixed samples of each
// test split, drawn once with a fixed seed: 200 GSM8K questions and 5 per MMLU subject.
// Item ids carry the original test-split index, so a run can be traced back to the dataset.

const GSM8K_MAX_TOKENS = 8192;
const MMLU_MAX_TOKENS = 1024;
const DATA_DIR = new URL("./data/", import.meta.url);

/** @param {string} name */
function loadData(name) {
  return JSON.parse(readFileSync(new URL(name, DATA_DIR), "utf8"));
}

let gsm8kRows = null;
let mmluRows = null;

function genGsm8k() {
  gsm8kRows ||= loadData("gsm8k-200.json");
  return gsm8kRows.map((r) => ({
    id: `gsm8k-${String(r.n).padStart(4, "0")}`,
    category: "gsm8k",
    prompt: `${r.q}\n\nSolve it step by step. End your reply with a line 'Answer: <number>' containing only the final number.`,
    expected: r.a,
    maxTokens: GSM8K_MAX_TOKENS,
    thinking: true,
  }));
}

function genMmlu() {
  mmluRows ||= loadData("mmlu-285.json");
  return mmluRows.map((r) => {
    const subject = r.s.replace(/_/g, " ");
    return {
      id: `mmlu-${String(r.n).padStart(5, "0")}`,
      category: "mmlu",
      subject: r.s,
      prompt:
        `The following is a multiple choice question about ${subject}.\n\n${r.q}\n` +
        r.c.map((c, i) => `${"ABCD"[i]}. ${c}`).join("\n") +
        `\n\nReply with the letter of the correct answer. End your reply with a line 'Answer: <letter>'.`,
      expected: r.a,
      maxTokens: MMLU_MAX_TOKENS,
      thinking: false,
    };
  });
}

// ─── Long-context needle recall ──────────────────────────

export const LONG_FILLER_WORDS = [
  "amber", "basil", "cedar", "delta", "ember", "fable", "garnet", "harbor", "indigo",
  "jasper", "kettle", "lantern", "meadow", "nectar", "orbit", "pepper", "quartz", "raven",
  "saffron", "timber", "umber", "velvet", "willow", "xenon", "yarrow", "zephyr",
];
const LONG_ANIMALS = [
  "otter", "falcon", "badger", "lynx", "heron", "walrus", "gecko", "bison", "marmot",
  "ibis", "jackal", "koala", "lemur", "moose", "newt", "ocelot", "puffin", "quokka",
  "raccoon", "salmon", "tapir", "urchin", "vole", "wombat",
];
const LONG_WORDS_PER_TOKEN = 0.72;
const LONG_FACTS = 16;
const LONG_CORRECTIONS = 4;

/** Compact size label (8k … 256k). */
export function longSizeLabel(tokens) {
  const n = Number(tokens);
  return n >= 1024 && n % 1024 === 0 ? `${n / 1024}k` : String(n);
}

/**
 * @param {number} size target tokens
 * @param {number} index 1-based item index within that size
 */
export function longItem(size, index) {
  const id = `long-${longSizeLabel(size)}-${index}`;
  const seed = hashString(`sparkdash-quality-v${SUITE_VERSION}:${id}`);
  const rng = mulberry32(seed);
  const names = shuffled(rng, LONG_ANIMALS).slice(0, LONG_FACTS);
  const used = new Set();
  const code = () => {
    let c;
    do c = randint(rng, 10000, 99999);
    while (used.has(c));
    used.add(c);
    return String(c);
  };
  const facts = names.map((name) => ({ name, code: code(), corrected: null }));
  for (const f of shuffled(rng, facts).slice(0, LONG_CORRECTIONS)) f.corrected = code();
  return {
    id,
    category: "long",
    size,
    seed,
    facts,
    askOrder: shuffled(rng, names),
    maxTokens: LONG_MAX_TOKENS,
    thinking: false,
  };
}

/**
 * Rebuild the (large) prompt for a long item. Deterministic from item.seed.
 * @param {ReturnType<typeof longItem>} item
 */
export function buildLongPrompt(item) {
  const rng = mulberry32((item.seed ^ 0x9e3779b9) >>> 0);
  const fillerWords = Math.max(240, Math.round(item.size * LONG_WORDS_PER_TOKEN) - 300);
  const nSentences = Math.ceil(fillerWords / 12);
  /** @type {Map<number, string[]>} after sentence index → inserted sentences */
  const inserts = new Map();
  const add = (at, text) => {
    const list = inserts.get(at) || [];
    list.push(text);
    inserts.set(at, list);
  };
  const early = 0.7 * nSentences;
  item.facts.forEach((f, i) => {
    const slot = early / LONG_FACTS;
    add(Math.floor(i * slot + rng() * slot), `Remember this: the code for ${f.name} is ${f.code}.`);
  });
  const corrected = item.facts.filter((f) => f.corrected);
  corrected.forEach((f, j) => {
    const slot = (nSentences - early) / corrected.length;
    add(Math.min(nSentences - 1, Math.floor(early + j * slot + rng() * slot)), `Correction: the code for ${f.name} has changed, it is now ${f.corrected}.`);
  });

  const parts = [];
  for (let s = 0; s < nSentences; s++) {
    const words = [];
    for (let w = 0; w < 12; w++) words.push(LONG_FILLER_WORDS[Math.floor(rng() * LONG_FILLER_WORDS.length)]);
    words[0] = words[0][0].toUpperCase() + words[0].slice(1);
    parts.push(`${words.join(" ")}.`);
    const extra = inserts.get(s);
    if (extra) parts.push(...extra);
    if (s % 10 === 9) parts.push("\n");
  }
  const body = parts.join(" ").replace(/ \n /g, "\n");
  return (
    `${body}\n\n` +
    "Some codes were corrected later in the text; use the latest value for each. " +
    "List the current code for each of these, one per line as 'name: code':\n" +
    item.askOrder.join("\n")
  );
}

/** Long sizes that fit: prompt + answer headroom within the known context. */
export function longSizesForContext(sizes, contextLength) {
  const ctx = Number(contextLength);
  if (!Number.isFinite(ctx) || ctx <= 0) return { run: [...sizes], skipped: [] };
  const run = [];
  const skipped = [];
  // Sizes are nominal (0.72 words/token). Real prompts run ~1.0x (o200k) to ~1.2x (cl100k/Llama-3)
  // of that, more on small-vocab tokenizers, so keep 20% headroom or the request is a 400.
  // Same rule as the dialog (src/shared/contextFit.js): 20% headroom + the reply budget.
  for (const s of sizes) (qualityLongFitsContext(s, ctx) ? run : skipped).push(s);
  return { run, skipped };
}

// ─── Suite assembly ──────────────────────────────────────

const GENERATORS = { qa: genQa, reason: genReason, arith: genArith, track: genTrack, gsm8k: genGsm8k, mmlu: genMmlu, follow: genFollow };

/**
 * @param {{ categories?: string[], longSizes?: number[], longItems?: number }} [opts]
 */
export function generateSuite({ categories = QUALITY_CATEGORIES, longSizes = [], longItems = 2 } = {}) {
  const items = [];
  for (const cat of QUALITY_CATEGORIES) {
    if (!categories.includes(cat)) continue;
    if (cat === "long") {
      for (const size of longSizes) {
        for (let i = 1; i <= longItems; i++) items.push(longItem(size, i));
      }
    } else {
      items.push(...GENERATORS[cat]());
    }
  }
  return items;
}

// ─── Scoring ─────────────────────────────────────────────

/**
 * Drop `<think>…</think>` spans (and an unterminated trailing `<think>`) that
 * some servers leave in `content` when no reasoning parser is configured.
 * @param {string} text
 */
export function visibleAnswer(text) {
  let s = String(text ?? "");
  s = s.replace(/<think>[\s\S]*?<\/think>/gi, "");
  if (/<\/think>/i.test(s)) s = s.slice(s.toLowerCase().lastIndexOf("</think>") + 8);
  const open = s.toLowerCase().indexOf("<think>");
  if (open >= 0) s = s.slice(0, open);
  return s.trim();
}

/** Last integer in the text (digits only, leading zeros dropped). */
export function lastInteger(text) {
  const m = String(text ?? "").match(/\d+/g);
  if (!m) return null;
  return m[m.length - 1].replace(/^0+(?=\d)/, "");
}

/**
 * Numbers in a reply, in order. Thousands commas are folded in ("1,234"), a minus counts only
 * when it is a sign (not the dash in "2024-01-01"), and a list like "1, 2, 3" is three numbers.
 */
export function numbersIn(text) {
  const out = [];
  const re = /-?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?/g;
  let m;
  const s = String(text ?? "");
  while ((m = re.exec(s))) {
    let tok = m[0];
    const prev = m.index > 0 ? s[m.index - 1] : "";
    if (tok.startsWith("-") && /[\w]/.test(prev)) tok = tok.slice(1);
    // "1,2,4" is a list, not 12,4: a comma group only counts as thousands when it is exactly 3 digits.
    const n = Number(tok.replace(/,/g, ""));
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

/**
 * QA scoring. The reply must *commit* to the answer, not merely mention it:
 *  - number: the last number in the reply is the answer ("1391" and "391 or 5" fail).
 *  - date: the last YYYY-MM-DD in the reply is the answer.
 *  - list: the last N integers, in order, are the sorted list.
 *  - word: the answer appears as a whole word in a short reply (a hedge or an essay fails).
 * Legacy "substring"/"exact" modes are kept for saved items.
 */
const HEDGE_RE = /\b(?:or|maybe|perhaps|either)\b|\d\s*\/\s*\d/i;

const NEG_BEFORE = new Set([
  "not", "no", "never", "neither", "nor", "without", "except", "unlike", "than", "isn't", "wasn't", "aren't",
  "don't", "doesn't", "didn't", "can't", "cannot", "won't", "wouldn't", "shouldn't", "hardly",
]);
const NEG_AFTER_1 = new Set(["isn't", "wasn't", "aren't", "wrong", "incorrect", "false", "untrue"]);

/**
 * True when a negation/hedge sits next to tokens[i]: "not canberra", "no, not yes" before it, or
 * "canberra is wrong / isn't" after it. "Canberra, not Sydney" is a correct reply and is allowed.
 */
function negatedAt(tokens, i, wants) {
  for (let k = Math.max(0, i - 2); k < i; k++) if (NEG_BEFORE.has(tokens[k]) && !wants.includes(tokens[k])) return true;
  const t1 = tokens[i + 1];
  const t2 = tokens[i + 2];
  if (t1 && NEG_AFTER_1.has(t1)) return true;
  if (t1 && ["is", "was", "are"].includes(t1) && t2 && (t2 === "not" || NEG_AFTER_1.has(t2))) return true;
  return false;
}

export function scoreQa(item, reply) {
  const text = visibleAnswer(reply);
  const want = item.accept.map(String);
  switch (item.mode) {
    case "number": {
      const nums = numbersIn(text);
      const target = want.map((w) => Number(w.replace(/,/g, "")));
      const got = nums.length ? nums[nums.length - 1] : null;
      // Strict: the *last* number commits. A reply that leads with the right number and then
      // corrects itself ("391. Correction: I made an error, it is 5") must fail.
      return { ok: got != null && target.includes(got) };
    }
    case "date": {
      const all = text.match(/\d{4}-\d{2}-\d{2}/g);
      return { ok: Boolean(all) && all[all.length - 1] === want[0] };
    }
    case "list": {
      const nums = want[0].match(/\d+/g).map(Number);
      const got = (text.match(/\d+/g) ?? []).map(Number);
      const tail = got.slice(-nums.length);
      return { ok: got.length >= nums.length && tail.every((n, i) => n === nums[i]) };
    }
    case "word": {
      const tokens = text.toLowerCase().match(/[a-z0-9']+/g) ?? [];
      if (tokens.length === 0) return { ok: false };
      const wants = want.map((w) => w.toLowerCase());
      // An occurrence of the answer only counts when no negation sits right next to it
      // ("Not canberra", "No, not yes", "canberra is wrong").
      const clean = (i) => wants.includes(tokens[i]) && !negatedAt(tokens, i, wants);
      const hits = tokens.map((t, i) => (wants.includes(t) ? i : -1)).filter((i) => i >= 0);
      const named = hits.length > 0 && hits.every(clean);
      // Short reply that names it, or a longer one that *ends* on it / puts it in the last bold span.
      if (tokens.length <= 15 && !HEDGE_RE.test(text) && named) return { ok: true };
      const bold = [...text.matchAll(/\*\*([^*]+)\*\*/g)].pop();
      const boldTokens = bold ? (bold[1].toLowerCase().match(/[a-z0-9']+/g) ?? []) : [];
      const endsOn = clean(tokens.length - 1) || (boldTokens.length === 1 && wants.includes(boldTokens[0]) && !negatedAt(boldTokens, 0, wants));
      return { ok: endsOn };
    }
    case "exact": {
      const got = lastInteger(text);
      const w = want[0].replace(/^0+(?=\d)/, "");
      return { ok: got != null && got === w };
    }
    default: {
      const lower = text.toLowerCase();
      return { ok: want.some((a) => lower.includes(a.toLowerCase())) };
    }
  }
}

// A number: thousands groups must be exactly three digits; decimals allowed (they are then
// compared as numbers, so "1200.9" is not 1200 and "1200.0" is).
const NUM_TOKEN = String.raw`-?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?`;
// The label, then the rest of that line. The remainder must be *only* the answer (markdown, $,
// backticks and a trailing period tolerated), so "1200 or 1201" and "32, 33" do not pass.
const ANSWER_LINE_RE = /answer[*\s]*:[*\s$€£`]*([^\n]*)/gi;
const WRAP = String.raw`[*\s$€£\`_]*`;
// Single-number answers also take a unit suffix ("25%", "18 dollars", "12 square feet", "5 km/h"),
// but never a second value or a hedge ("1200 or 1201", "5 is wrong"). Non-breaking/narrow spaces
// count as thousands separators ("1\u202f234").
const SUFFIX_STOP = String.raw`(?:or|and|to|vs|but|then|maybe|perhaps|is|are|was|not|no|wrong|incorrect)`;
const SUFFIX_WORD = String.raw`(?!${SUFFIX_STOP}\b)[A-Za-z]+`;
const SINGLE_NUM = String.raw`-?(?:\d{1,3}(?:[,\u00a0\u202f]\d{3})+|\d+)(?:\.\d+)?`;
const SINGLE_FULL = new RegExp(
  String.raw`^${WRAP}(${SINGLE_NUM})${WRAP}(?:%|\s*${SUFFIX_WORD}(?:[ /-]${SUFFIX_WORD}){0,2})?${WRAP}\.?${WRAP}$`,
  "i"
);
const PAIR_FULL = new RegExp(String.raw`^${WRAP}(${NUM_TOKEN})${WRAP},${WRAP}(${NUM_TOKEN})${WRAP}\.?${WRAP}$`);

/** Remainder of the last 'Answer:' line in the visible reply, or null. */
function lastAnswerRemainder(text) {
  let last = null;
  for (const m of visibleAnswer(text).matchAll(ANSWER_LINE_RE)) last = m;
  return last ? last[1] : null;
}

const toNum = (tok) => Number(tok.replace(/[,\u00a0\u202f]/g, ""));

/** @returns {{ jar: number, box: number } | null} */
export function parseReasonAnswer(text) {
  const rest = lastAnswerRemainder(text);
  const m = rest == null ? null : rest.match(PAIR_FULL);
  return m ? { jar: toNum(m[1]), box: toNum(m[2]) } : null;
}

export function scoreReason(item, reply) {
  const got = parseReasonAnswer(reply);
  return {
    ok: got != null && got.jar === item.expected.jar && got.box === item.expected.box,
    parsed: got ? `${got.jar}, ${got.box}` : null,
    labeled: lastAnswerRemainder(reply) != null,
  };
}

/** Last 'Answer: N' line as a Number (markdown, $ and thousands commas allowed), or null. */
export function parseSingleAnswer(text) {
  const rest = lastAnswerRemainder(text);
  const m = rest == null ? null : rest.match(SINGLE_FULL);
  if (!m) return null;
  const n = toNum(m[1]);
  return Number.isFinite(n) ? n : null;
}

export function scoreSingle(item, reply) {
  const got = parseSingleAnswer(reply);
  return {
    ok: got != null && got === item.expected,
    parsed: got != null ? String(got) : null,
    labeled: lastAnswerRemainder(reply) != null,
  };
}

/**
 * @returns {{ ok: boolean, correct: number, total: number, stale: number }}
 */
const LONG_OLD_RE = /\b(was|were|originally|previously|formerly|initially|earlier|old|original|replaced|changed from|instead of)\b/i;

/**
 * Code the reply gives for `name`, or null. Per line, the text after a name runs to the next
 * animal's name (so "a: 1, b: 2" works); parenthetical asides ("(was 48213)") are dropped, and a
 * clause that only says what the code *used to be* ("otter was originally 48213") is ignored.
 */
function longCodeFor(lines, name, allNames) {
  const nameRe = new RegExp(`\\b${name}\\b`, "ig");
  const others = new RegExp(`\\b(?:${allNames.filter((n) => n !== name).join("|")})\\b`, "i");
  let got = null;
  for (const line of lines) {
    nameRe.lastIndex = 0;
    let m;
    while ((m = nameRe.exec(line))) {
      let seg = line.slice(m.index + m[0].length);
      const next = seg.search(others);
      if (next >= 0) seg = seg.slice(0, next);
      seg = seg.replace(/\([^)]*\)/g, " ");
      const codes = seg.match(/\b\d{5}\b/g);
      if (!codes) continue;
      const before = seg.slice(0, seg.search(/\b\d{5}\b/));
      if (LONG_OLD_RE.test(before) && !/->|→|=>|now|updated|corrected|changed to/i.test(seg)) continue;
      got = codes[codes.length - 1];
    }
  }
  return got;
}

/**
 * @returns {{ ok: boolean, correct: number, total: number, stale: number }}
 */
export function scoreLong(item, reply) {
  const lines = visibleAnswer(reply).split(/\r?\n/);
  const names = item.facts.map((f) => f.name);
  let correct = 0;
  let stale = 0;
  for (const f of item.facts) {
    const got = longCodeFor(lines, f.name, names);
    const latest = f.corrected || f.code;
    if (got === latest) correct += 1;
    else if (f.corrected && got === f.code) stale += 1;
  }
  const total = item.facts.length;
  return { ok: correct === total, correct, total, stale };
}

export function scoreFollow(item, reply) {
  const text = visibleAnswer(reply);
  // Rules like max-words or forbid hold trivially for nothing: an empty reply is a failure.
  if (!text.trim()) return { ok: false, passed: 0, total: item.rules.length };
  const passed = item.rules.filter((r) => followCheck(r, text)).length;
  return { ok: passed === item.rules.length, passed, total: item.rules.length };
}

// A line that commits to a letter: "Answer: B", "ANSWER: B", "**Answer: (B)**", "The correct answer
// is (B) foo", "Answer: B. Paris". The label is case-insensitive; a bare letter must be uppercase
// (so "Answer: a cat" is not A) and be followed by the end of the line or punctuation (so
// "Answer: A cat" is not A). A parenthesised letter may be followed by anything. Either way a
// hedge after it ("B or C", "B, C", "B / C") is rejected.
const MMLU_LABEL_RE = /\banswer\b[*\s]*(?::|is)/i;
const MMLU_LINE_RE =
  /\banswer\b[*\s]*(?::|is)[*\s"'`_]*(?:(?:option|choice)\s+)?(?:\(([ABCDabcd])\)|([ABCD])(?![A-Za-z0-9]))[*\s"'`_]*(.*)$/i;
const MMLU_HEDGE_AFTER_RE =
  /^[\s,;/&]*(?:or|and|\/|&)\b|^\s*[,;/&]\s*(?:\(?[ABCDabcd]\)?(?![A-Za-z0-9])|but|though|however|also|maybe|perhaps)/i;

function mmluLetter(line) {
  const m = line.match(MMLU_LINE_RE);
  if (!m) return null;
  const paren = m[1] != null;
  // The 'i' flag makes ([ABCD]) match lowercase too; re-impose uppercase for the bare form.
  const letter = m[1] ?? m[2];
  if (!paren && letter !== letter.toUpperCase()) return null;
  const rest = m[3] ?? "";
  if (MMLU_HEDGE_AFTER_RE.test(rest)) return null;
  // Bare letter: only the end of the line or punctuation may follow ("B. Paris", "B) Paris", "B - Paris").
  if (!paren && rest.trim() && !/^[.):,;\-\u2013\u2014!]/.test(rest.trimStart())) return null;
  return letter.toUpperCase();
}

/**
 * The last line that commits to a letter, else a final line that is just a letter ("B", "**C**",
 * "(d)", "D."), else null.
 */
export function parseMmluAnswer(text) {
  const lines = visibleAnswer(text).split(/\r?\n/);
  let last = null;
  for (const line of lines) {
    const l = mmluLetter(line);
    if (l) last = l;
  }
  if (last) return last;
  const final = [...lines].reverse().find((l) => l.trim());
  const bare = final?.match(/^[*\s(]*([ABCDabcd])[*\s).:]*$/);
  return bare ? bare[1].toUpperCase() : null;
}

export function scoreMmlu(item, reply) {
  const got = parseMmluAnswer(reply);
  return { ok: got === item.expected, parsed: got, labeled: MMLU_LABEL_RE.test(visibleAnswer(reply)) };
}

/** Score any item. */
export function scoreItem(item, reply) {
  switch (item.category) {
    case "qa":
      return scoreQa(item, reply);
    case "reason":
      return scoreReason(item, reply);
    case "arith":
    case "track":
    case "gsm8k":
      return scoreSingle(item, reply);
    case "mmlu":
      return scoreMmlu(item, reply);
    case "follow":
      return scoreFollow(item, reply);
    case "long":
      return scoreLong(item, reply);
    default:
      throw new Error(`scoreItem: ${item.category} is not text-scored`);
  }
}

/**
 * Per-category summary + overall (mean of category percentages). Rows with `error` are excluded
 * from `passed`/`scored`/`pct` (see `errors`); `total` is every row.
 * @param {Array<{ category: string, ok: boolean, completionTokens?: number, finishReason?: string | null, longCorrect?: number, longTotal?: number, longStale?: number, error?: string | null }>} rows
 */
export function summarize(rows) {
  /** @type {Record<string, any>} */
  const categories = {};
  for (const r of rows) {
    const c =
      categories[r.category] ||
      (categories[r.category] = { passed: 0, total: 0, scored: 0, pct: null, errors: 0, completionTokens: 0, hitMaxTokens: 0 });
    c.total += 1;
    // A request error / timeout says nothing about the model: it is reported (errors) but
    // neither counts as a failure nor sits in the pct denominator.
    if (r.error) c.errors += 1;
    else {
      c.scored += 1;
      if (r.ok) c.passed += 1;
    }
    c.completionTokens += Number(r.completionTokens) || 0;
    if (r.finishReason === "length") c.hitMaxTokens += 1;
    if (r.category === "long") {
      c.keysFound = (c.keysFound || 0) + (Number(r.longCorrect) || 0);
      c.keysTotal = (c.keysTotal || 0) + (Number(r.longTotal) || 0);
      c.stale = (c.stale || 0) + (Number(r.longStale) || 0);
    }
  }
  const pcts = [];
  for (const c of Object.values(categories)) {
    c.pct = c.scored ? Math.round((c.passed / c.scored) * 1000) / 10 : null;
    c.meanCompletionTokens = c.total ? Math.round(c.completionTokens / c.total) : 0;
    delete c.completionTokens;
    if (c.pct != null) pcts.push(c.pct);
  }
  const overallPct = pcts.length ? Math.round((pcts.reduce((a, b) => a + b, 0) / pcts.length) * 10) / 10 : null;
  return { categories, overallPct };
}
