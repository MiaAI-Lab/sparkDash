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
import { QUALITY_CATEGORIES, qualityRowUnscored, wilsonInterval } from "../../src/shared/qualityBench.js";
import { divergenceRates } from "../../src/shared/qualityDivergence.js";
// Circular on purpose: the divergence prompts reuse this module's generators, called lazily.
import { divergenceItems } from "./qualityDivergence.js";
import { qualityLongFitsContext } from "../../src/shared/contextFit.js";

/**
 * Item generation (prompts, ids, seeds). Bump when the item set changes.
 *   1: the original suite (QA 150, reasoning / arithmetic / tracking 40 each, long 2 per size)
 *   2: reasoning 200 in five problem shapes; arithmetic 200 (100 ten-step, 100 twenty-step) and
 *      tracking 200 (100 × 25 events, 100 × 50 events) graded by intermediate values; long recall
 *      5 per size with three needle depths; string reversal, letter counts and binary moved from
 *      QA to the optional Tokenizer category; QA budget 256 tokens; GSM8K re-labelled with
 *      GSM8K-Platinum (188 items); MMLU-Pro (300, thinking on) and MATH-500 added, plain MMLU optional
 */
export const SUITE_VERSION = 2;
/**
 * Scoring rules (parsers, QA modes). Bump whenever a change could flip an item's pass/fail for the
 * same reply; stored in each run's config so compareQualityRuns can refuse to pair runs scored by
 * different rules.
 *   1: original parsers
 *   2: strict QA 'last number' (no lead-with-answer fallback), negation-aware word mode,
 *      case-insensitive / suffix-tolerant Answer parsing (MMLU, GSM8K/arith/track)
 *   3: replies cut off by max_tokens before an answer and disputed GSM8K items are reported,
 *      not failed; QA binary items read the last binary string; a quoted word, a committed
 *      lead ("Yes. Because…"), \boxed{}, a Unicode minus and a trailing working ("540 (3*3*60)")
 *      are read; MMLU reads a final "C. 24" / "C) 24" line; follow rows name the failed rules
 *   4: graded scorers (suite v2): arithmetic counts the correct 'Step n: <value>' lines, tracking
 *      reads every person's total from 'Answer: Ana=<n>, …'; reasoning answers are any two numbers;
 *      a restated instruction ('Answer: <final number>') is not read as an answer line
 */
export const SCORING_VERSION = 4;
/** Fixed `seed` field sent with every request (servers that honour it stay reproducible). */
export const REQUEST_SEED = 1234;

/** Suite v2: room to show the working before the number (64 cut off models that reason in the open). */
const QA_MIN_TOKENS = 256;
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
  ["What is the binary representation of 13? Digits only.", ["1101"], 12, "binary"],
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

function qaItem(id, prompt, accept, mode = null, maxTokens = QA_MIN_TOKENS, category = "qa") {
  mode = mode && mode !== "substring" ? mode : qaModeFor(accept);
  return {
    id,
    category,
    prompt,
    accept: uniq(accept),
    mode,
    maxTokens: Math.max(maxTokens, QA_MIN_TOKENS),
    thinking: false,
  };
}

/** Fixed QA items that test the tokenizer (reversal, letter counts, binary): the Tokenizer category since suite v2. */
const QA_FIXED_TOKENIZER = new Set([11, 12, 25, 29]);

function genQa() {
  const items = QA_FIXED.flatMap(([q, accept, max, mode], i) =>
    QA_FIXED_TOKENIZER.has(i + 1) ? [] : [qaItem(`qa-fixed-${pad2(i + 1)}`, q, accept, mode ?? null, max)]
  );
  const rng = rngFor("qa");

  for (let i = 1; i <= 29; i++) {
    const a = randint(rng, 100, 999);
    const b = randint(rng, 10, 99);
    const p = a * b;
    items.push(qaItem(`qa-mul-${pad2(i)}`, `What is ${a} * ${b}? Answer with the number only.`, [String(p), commafy(p)]));
  }
  for (let i = 1; i <= 25; i++) {
    const a = randint(rng, 1000, 9999);
    const b = randint(rng, 1000, 9999);
    const c = randint(rng, 1000, 9999);
    const r = a + b - c;
    items.push(qaItem(`qa-addsub-${pad2(i)}`, `What is ${a} + ${b} - ${c}? Answer with the number only.`, [String(r), commafy(r)]));
  }
  for (let i = 1; i <= 20; i++) {
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
  const base = Date.UTC(2020, 0, 1);
  const span = Math.round((Date.UTC(2030, 11, 31) - base) / 86_400_000);
  for (let i = 1; i <= 25; i++) {
    const d0 = new Date(base + randint(rng, 0, span) * 86_400_000);
    const k = randint(rng, 3, 60);
    const d1 = new Date(d0.getTime() + k * 86_400_000);
    const iso = (d) => d.toISOString().slice(0, 10);
    items.push(
      qaItem(`qa-date-${pad2(i)}`, `What date is ${k} days after ${iso(d0)}? Answer in YYYY-MM-DD format only.`, [iso(d1)], "date")
    );
  }
  for (let i = 1; i <= 25; i++) {
    const a = randint(rng, 2, 30);
    const b = randint(rng, 2, 30);
    const l = (a * b) / gcd(a, b);
    items.push(qaItem(`qa-lcm-${pad2(i)}`, `What is the least common multiple of ${a} and ${b}? Number only.`, [String(l)]));
  }
  return items;
}

// ─── Tokenizer (sub-word puzzles, thinking off; optional since suite v2) ─────
//
// Reversing a string, counting a letter and writing a number in binary are decided by how the
// tokenizer splits the text, not by reasoning: every model fails some of them thinking-off. They
// were a fifth of QA and dragged a score that was meant to read as basic accuracy, so they are
// their own optional category, scored by the same QA rules.

function genTokenizer() {
  const items = QA_FIXED.flatMap(([q, accept, max, mode], i) =>
    QA_FIXED_TOKENIZER.has(i + 1) ? [qaItem(`tok-fixed-${pad2(i + 1)}`, q, accept, mode ?? null, max, "tokenizer")] : []
  );
  const rng = rngFor("tokenizer");
  for (let i = 1; i <= 15; i++) {
    const len = randint(rng, 6, 10);
    let s = "";
    for (let j = 0; j < len; j++) s += String.fromCharCode(97 + randint(rng, 0, 25));
    const rev = [...s].reverse().join("");
    items.push(qaItem(`tok-rev-${pad2(i)}`, `Reverse the string '${s}'. Answer with the reversed string only.`, [rev], null, QA_MIN_TOKENS, "tokenizer"));
  }
  for (let i = 1; i <= 15; i++) {
    const w = COUNT_WORDS[i - 1];
    const ch = pick(rng, [...w]);
    const n = [...w].filter((x) => x === ch).length;
    items.push(
      qaItem(`tok-count-${pad2(i)}`, `How many times does the letter '${ch}' appear in the word '${w}'? Number only.`, [String(n)], null, QA_MIN_TOKENS, "tokenizer")
    );
  }
  const usedBin = new Set();
  for (let i = 1; i <= 10; i++) {
    let n = randint(rng, 20, 255);
    while (usedBin.has(n)) n = randint(rng, 20, 255);
    usedBin.add(n);
    items.push(qaItem(`tok-bin-${pad2(i)}`, `What is the binary representation of ${n}? Digits only.`, [n.toString(2)], "binary", QA_MIN_TOKENS, "tokenizer"));
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

const REASON_ITEMS_PER_SHAPE = 40;
const REASON_SHOP = [
  ["notebook", 3, 9], ["pen", 1, 4], ["mug", 5, 12], ["candle", 2, 8], ["poster", 4, 11], ["puzzle", 6, 15],
];

/**
 * Five problem shapes, 40 each (suite v2): the same template repeated gives less independent
 * evidence than diverse problems. Every shape asks for two whole numbers on one line,
 * 'Answer: <first>, <second>', so one parser serves all of them.
 */
const REASON_SHAPES = {
  // A: three people, transfers, a doubling, then a split into boxes with a jar for the leftover.
  boxes(rng) {
    const [A, B, C] = shuffled(rng, REASON_NAMES).slice(0, 3);
    const things = pick(rng, REASON_THINGS);
    const x = randint(rng, 20, 90);
    const k = randint(rng, 2, 5);
    const g = randint(rng, 3, 15);
    const c = randint(rng, 5, 40);
    const h = randint(rng, 2, Math.floor(x / 2));
    const p = pick(rng, [2, 3, 4]);
    const total = x - h + (k * x - g) + 2 * (c + g);
    return {
      prompt:
        `${A} has ${x} ${things}. ${B} has ${k} times as many ${things} as ${A}. ${C} has ${c} ${things}. ` +
        `${B} gives ${g} ${things} to ${C}. Then ${A} loses ${h} ${things}, and ${C} doubles the number of ${things} they have. ` +
        `Then all three put their ${things} together and split them as evenly as possible into ${p} boxes, ` +
        `putting any leftover ${things} in a jar. How many ${things} are in the jar, and how many are in each box? ` +
        `End your reply with a line 'Answer: <jar>, <per box>'.`,
      expected: { first: total % p, second: Math.floor(total / p) },
    };
  },
  // B: a purchase with a discount and change from a round payment.
  shop(rng) {
    const A = pick(rng, REASON_NAMES);
    const [[item1, lo1, hi1], [item2, lo2, hi2]] = shuffled(rng, REASON_SHOP).slice(0, 2);
    const p1 = randint(rng, lo1, hi1);
    const p2 = randint(rng, lo2, hi2);
    const n1 = randint(rng, 2, 9);
    const n2 = randint(rng, 2, 9);
    const off = pick(rng, [2, 3, 4, 5]);
    const gross = n1 * p1 + n2 * p2;
    const spent = Math.max(1, gross - off);
    const paid = Math.ceil(spent / 20) * 20 + 20;
    return {
      prompt:
        `A ${item1} costs ${p1} dollars and a ${item2} costs ${p2} dollars. ${A} buys ${n1} ${item1}s and ${n2} ${item2}s ` +
        `and gets ${off} dollars off the total. ${A} pays with ${paid} dollars in cash. How much did ${A} spend, and how much change did ${A} get? ` +
        `End your reply with a line 'Answer: <spent>, <change>'.`,
      expected: { first: spent, second: paid - spent },
    };
  },
  // C: two trips at constant speed; minutes each, chosen so both divide evenly.
  travel(rng) {
    const [A, B] = shuffled(rng, REASON_NAMES).slice(0, 2);
    const v1 = pick(rng, [40, 60, 80, 90, 120]);
    const v2 = pick(rng, [30, 45, 60, 75, 90]);
    const m1 = pick(rng, [30, 45, 60, 90, 120, 150]);
    const m2 = pick(rng, [20, 40, 60, 80, 100, 140]);
    const d1 = (v1 * m1) / 60;
    const d2 = (v2 * m2) / 60;
    const stop = randint(rng, 5, 25);
    return {
      prompt:
        `${A} drives ${d1} km at a steady ${v1} km/h. ${B} cycles ${d2} km at a steady ${v2} km/h and stops once for ${stop} minutes. ` +
        `How many minutes does ${A}'s trip take, and how many minutes does ${B}'s trip take including the stop? ` +
        `End your reply with a line 'Answer: <${A} minutes>, <${B} minutes>'.`,
      expected: { first: m1, second: m2 + stop },
    };
  },
  // D: ages now and in n years.
  ages(rng) {
    const [A, B, C] = shuffled(rng, REASON_NAMES).slice(0, 3);
    const a = randint(rng, 6, 15);
    const k = randint(rng, 2, 4);
    const d = randint(rng, 1, 9);
    const n = randint(rng, 3, 12);
    const b = k * a;
    const c = b + d;
    return {
      prompt:
        `${A} is ${a} years old. ${B} is ${k} times as old as ${A}. ${C} is ${d} years older than ${B}. ` +
        `In ${n} years, what will the three ages add up to, and how much older than ${A} will ${C} be then? ` +
        `End your reply with a line 'Answer: <sum of ages>, <difference>'.`,
      expected: { first: a + b + c + 3 * n, second: c - a },
    };
  },
  // E: sharing a batch in stages: a fraction, then a fixed number, then the rest.
  shares(rng) {
    const [A, B, C] = shuffled(rng, REASON_NAMES).slice(0, 3);
    const things = pick(rng, REASON_THINGS);
    const k = pick(rng, [2, 3, 4, 5]);
    const unit = randint(rng, 8, 30);
    const total = k * unit;
    const first = unit; // A takes 1/k
    const m = randint(rng, 2, Math.max(2, Math.floor((total - first) / 2)));
    const rest = total - first - m;
    return {
      prompt:
        `A crate holds ${total} ${things}. ${A} takes one ${k === 2 ? "half" : k === 3 ? "third" : k === 4 ? "quarter" : "fifth"} of them. ` +
        `${B} then takes ${m} of what is left, and ${C} gets the remainder. How many ${things} does ${C} get, and how many do ${B} and ${C} have together? ` +
        `End your reply with a line 'Answer: <${C}'s ${things}>, <${B} and ${C} together>'.`,
      expected: { first: rest, second: m + rest },
    };
  },
};

function genReason() {
  const rng = rngFor("reason");
  const items = [];
  let i = 0;
  for (const [shape, make] of Object.entries(REASON_SHAPES)) {
    for (let j = 1; j <= REASON_ITEMS_PER_SHAPE; j++) {
      i += 1;
      const { prompt, expected } = make(rng);
      items.push({ id: `reason-${String(i).padStart(3, "0")}`, category: "reason", shape, prompt, expected, maxTokens: REASON_MAX_TOKENS, thinking: true });
    }
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

/** Suite v2: 100 ten-step and 100 twenty-step chains, each step's value asked for (graded). */
const ARITH_SHAPES = [
  { steps: 10, count: 100 },
  { steps: 20, count: 100 },
];

function genArith() {
  const rng = rngFor("arith");
  const items = [];
  const ops = ["mul", "add", "sub", "mod", "div"];
  let i = 0;
  for (const shape of ARITH_SHAPES) for (let n = 0; n < shape.count; n++) {
    i += 1;
    const v0 = randint(rng, 100, 999);
    let v = v0;
    const steps = [];
    const values = [];
    for (let s = 1; s <= shape.steps; s++) {
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
      values.push(v);
    }
    items.push({
      id: `arith-${String(i).padStart(3, "0")}`,
      category: "arith",
      steps: shape.steps,
      prompt:
        `Start with ${v0}. Then, in order: ${steps.join("; ")}. ` +
        `After each step write a line 'Step <n>: <value>' with the value at that point, then end your reply with a line 'Answer: <final number>'.`,
      expected: v,
      expectedSteps: values,
      maxTokens: CHAIN_MAX_TOKENS,
      thinking: true,
    });
  }
  return items;
}

// ─── Track (token transfers, thinking on) ────────────────

const TRACK_PEOPLE = ["Ana", "Bo", "Cy", "Di", "Ed"];

/** Suite v2: 100 stories of 25 events and 100 of 50, every person's total asked for (graded). */
const TRACK_SHAPES = [
  { events: 25, count: 100 },
  { events: 50, count: 100 },
];

function genTrack() {
  const rng = rngFor("track");
  const items = [];
  let i = 0;
  for (const shape of TRACK_SHAPES) for (let n = 0; n < shape.count; n++) {
    i += 1;
    /** @type {Record<string, number>} */
    const have = {};
    const sentences = [];
    for (const p of TRACK_PEOPLE) {
      have[p] = randint(rng, 20, 60);
      sentences.push(`${p} starts with ${have[p]} tokens.`);
    }
    for (let e = 0; e < shape.events; e++) {
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
    items.push({
      id: `track-${String(i).padStart(3, "0")}`,
      category: "track",
      events: shape.events,
      prompt:
        `Track the tokens carefully. ${sentences.join(" ")} How many tokens does each person have at the end? ` +
        `End your reply with a line 'Answer: ${TRACK_PEOPLE.map((p) => `${p}=<number>`).join(", ")}'.`,
      expected: { ...have },
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
/** MMLU-Pro needs reasoning (ten options, harder stems): thinking on with room for it. */
const MMLUPRO_MAX_TOKENS = 6144;
const MATH_MAX_TOKENS = 8192;

/**
 * GSM8K test-split items whose reference answer is wrong or whose wording admits more than one
 * reading. They were found by running three different models: every one of them "failed" the
 * same items with the same, defensible answer. The items still run (ids and pairing stay
 * stable; the reply is shown), but they are reported as disputed and never move the score.
 * Keyed by the test-split index (`n` in gsm8k-200.json).
 */
export const GSM8K_DISPUTED = {
  675: "Reference reads 'twice as many more dogs' as 24 more (36 dogs, 33 toys); 'twice as many' (24 dogs, 21 toys) is at least as natural.",
  782: "Reference counts both riders (54); the question can be read per rider (27).",
  835: "Reference divides the 18 hours between the three kangaroos (6 h each → 48 turtle-hours); '18 hours to travel across' also reads as the trip time (36).",
  951: "Reference treats '100 pages to the inch' as sheets (300 pages); read as pages it is 150.",
  952: "Reference answer 360 is wrong: 8:00 AM to 11:00 PM is 15 hours, 60 fifteen-minute intervals × 30 = 1,800 reports.",
  1035: "Fencepost: 24 ft at 3 ft spacing is 8 bottles (7 moves, 35 s) or 9 bottles (8 moves, 40 s).",
};
const DATA_DIR = new URL("./data/", import.meta.url);

/** @param {string} name */
function loadData(name) {
  return JSON.parse(readFileSync(new URL(name, DATA_DIR), "utf8"));
}

let gsm8kRows = null;
let mmluRows = null;
let mmluProRows = null;
let math500Rows = null;
let fidelityCorpus = null;

/**
 * The fidelity corpus (data/fidelity-corpus.json, built by scripts/build-fidelity-corpus.mjs): a
 * frozen set of documents the model scores by prompt log-probabilities. Its version and hash are
 * recorded on every run; runs across corpus versions do not pair.
 */
export function loadFidelityCorpus() {
  if (!fidelityCorpus) fidelityCorpus = loadData("fidelity-corpus.json");
  return fidelityCorpus;
}

/** One item per corpus document: the whole document is the prompt, nothing is generated. */
export function fidelityItems() {
  const corpus = loadFidelityCorpus();
  return corpus.docs.map((d) => ({
    id: `fid-${d.id}`,
    category: "fidelity",
    prompt: d.text,
    docId: d.id,
    kind: d.kind,
    lang: d.lang,
    chars: d.chars,
    bytes: Buffer.byteLength(d.text, "utf8"),
    docSha256: d.sha256,
    corpusVersion: corpus.version,
    corpusSha256: corpus.sha256,
    maxTokens: 1,
    thinking: false,
  }));
}

/**
 * Suite v2 reads the GSM8K-Platinum labels (data/gsm8k-platinum-200.json): the same 200 test items,
 * 188 of which Platinum kept, with two references revised to the answers the disputed list argued
 * for (952 → 1,800; 1,035 → 40) and the other disputed items removed. Nothing is disputed any more;
 * the map stays for the record and for runs saved from the original file.
 */
function genGsm8k() {
  gsm8kRows ||= loadData("gsm8k-platinum-200.json");
  return gsm8kRows.map((r) => ({
    id: `gsm8k-${String(r.n).padStart(4, "0")}`,
    category: "gsm8k",
    prompt: `${r.q}\n\nSolve it step by step. End your reply with a line 'Answer: <number>' containing only the final number.`,
    expected: r.a,
    maxTokens: GSM8K_MAX_TOKENS,
    thinking: true,
    ...(r.status ? {} : GSM8K_DISPUTED[r.n] ? { disputed: GSM8K_DISPUTED[r.n] } : {}),
  }));
}

const OPTION_LETTERS = "ABCDEFGHIJ";

/** MMLU-Pro (TIGER-Lab, MIT): up to ten options, reasoning required; a fixed stratified sample of 300. */
function genMmluPro() {
  mmluProRows ||= loadData("mmlu-pro-300.json");
  return mmluProRows.map((r) => ({
    id: `mmlupro-${String(r.n).padStart(5, "0")}`,
    category: "mmlupro",
    subject: r.cat,
    prompt:
      `The following is a multiple choice question about ${r.cat}.\n\n${r.q}\n` +
      r.o.map((c, i) => `${OPTION_LETTERS[i]}. ${c}`).join("\n") +
      `\n\nThink it through, then end your reply with a line 'Answer: <letter>'.`,
    expected: r.a,
    options: r.o.length,
    maxTokens: MMLUPRO_MAX_TOKENS,
    thinking: true,
  }));
}

/** MATH-500 (Hendrycks MATH, MIT): competition problems with LaTeX answers. */
function genMath500() {
  math500Rows ||= loadData("math500.json");
  return math500Rows.map((r, i) => ({
    id: `math500-${String(i + 1).padStart(3, "0")}`,
    category: "math500",
    source: r.id,
    subject: r.subject,
    level: r.level,
    prompt:
      `${r.q}\n\nSolve it step by step. End your reply with a line 'Answer: <final answer>' giving only the final answer, ` +
      `in LaTeX where needed (a fraction as \\frac{a}{b}, a point as (x, y), an interval as [a, b)); no units, no sentence.`,
    expected: r.a,
    maxTokens: MATH_MAX_TOKENS,
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
/**
 * Suite v2: where the facts sit, by item index — early (first 30 %), middle (30–60 %) or spread
 * over the first 70 % as in v1 — so recall is read at three needle depths. Corrections always
 * come in the last 30 %.
 */
export const LONG_DEPTHS = [
  { name: "spread", from: 0, to: 0.7 },
  { name: "early", from: 0, to: 0.3 },
  { name: "middle", from: 0.3, to: 0.6 },
];

export function longItem(size, index) {
  const id = `long-${longSizeLabel(size)}-${index}`;
  const seed = hashString(`sparkdash-quality-v${SUITE_VERSION}:${id}`);
  const rng = mulberry32(seed);
  const depth = LONG_DEPTHS[(index - 1) % LONG_DEPTHS.length];
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
    depth: depth.name,
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
  const depth = LONG_DEPTHS.find((d) => d.name === item.depth) || LONG_DEPTHS[0];
  const factsFrom = depth.from * nSentences;
  const factsSpan = (depth.to - depth.from) * nSentences;
  item.facts.forEach((f, i) => {
    const slot = factsSpan / LONG_FACTS;
    add(Math.floor(factsFrom + i * slot + rng() * slot), `Remember this: the code for ${f.name} is ${f.code}.`);
  });
  const early = 0.7 * nSentences;
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

const GENERATORS = { qa: genQa, tokenizer: genTokenizer, reason: genReason, arith: genArith, track: genTrack, gsm8k: genGsm8k, mmlu: genMmlu, mmlupro: genMmluPro, math500: genMath500, follow: genFollow };

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
    } else if (cat === "fidelity") {
      items.push(...fidelityItems());
    } else if (cat === "divergence") {
      items.push(...divergenceItems());
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
/** A later retraction turns a committed lead ("Yes. … actually, no") into a non-answer. */
const RETRACT_RE = /\b(?:actually|wait|correction|mistake|i was wrong|instead|sorry|on second thought|however)\b/i;
/** Words: letters/digits with inner apostrophes ("don't"), so quotes around a word are not part of it. */
const WORD_TOKEN_RE = /[a-z0-9]+(?:'[a-z0-9]+)*/g;

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
    case "binary": {
      // "1001011 64 + 8 + 2 + 1 = 75" commits to the binary string and then checks it in decimal:
      // the last run of 0/1 digits (4+ long, so a check's "1" or "10" is not one) is the answer.
      const bins = text.match(/(?<![0-9])[01]{4,}(?![0-9])/g);
      return { ok: Boolean(bins) && want.includes(bins[bins.length - 1]) };
    }
    case "word": {
      const tokens = text.toLowerCase().match(WORD_TOKEN_RE) ?? [];
      if (tokens.length === 0) return { ok: false };
      const wants = want.map((w) => w.toLowerCase());
      // An occurrence of the answer only counts when no negation sits right next to it
      // ("Not canberra", "No, not yes", "canberra is wrong").
      const clean = (i) => wants.includes(tokens[i]) && !negatedAt(tokens, i, wants);
      const hits = tokens.map((t, i) => (wants.includes(t) ? i : -1)).filter((i) => i >= 0);
      const named = hits.length > 0 && hits.every(clean);
      // Short reply that names it, or a longer one that *ends* on it / puts it in the last bold span.
      if (tokens.length <= 15 && !HEDGE_RE.test(text) && named) return { ok: true };
      // A committed lead: the answer opens the reply as its own sentence or clause ("Yes. This
      // follows from…", "Canberra, since…") and nothing later hedges or retracts it.
      const leadRe = new RegExp(`^[\\s"'*_\`]*(?:${wants.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})[*_"'\`]*(?:[.!,:;]|\\s[\u2013\u2014-]\\s)`, "i");
      if (leadRe.test(text) && named && !HEDGE_RE.test(text) && !RETRACT_RE.test(text)) return { ok: true };
      const bold = [...text.matchAll(/\*\*([^*]+)\*\*/g)].pop();
      const boldTokens = bold ? (bold[1].toLowerCase().match(WORD_TOKEN_RE) ?? []) : [];
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

/**
 * Make an answer remainder readable by the strict matchers without loosening them: LaTeX
 * wrappers (`\\boxed{540}`, `\\text{540}`, `$…$`), a Unicode minus, a lead-in such as "the final
 * number is", and a trailing working in parentheses ("540 (3*3*60)", "540 (meters)"). A
 * parenthetical that could be a second answer or a hedge ("(541)", "(or 541)") is kept, so it
 * still fails.
 */
export function normalizeAnswerRemainder(rest, { paren: dropParen = true } = {}) {
  let r = String(rest ?? "");
  for (let i = 0; i < 4; i++) {
    const next = r.replace(/\\(?:boxed|text|textbf|mathrm|mathbf)\s*\{([^{}]*)\}/g, "$1");
    if (next === r) break;
    r = next;
  }
  r = r.replace(/\$+/g, " ").replace(/[\u2212\u2013]/g, "-");
  r = r.replace(/^[\s*_`]*(?:the\s+)?(?:final\s+)?(?:number|answer|result|total|value)\s+(?:is|=)\s*/i, "");
  const paren = dropParen ? r.match(/\s*\(([^()]*)\)[\s*_`.]*$/) : null;
  if (
    paren &&
    r.slice(0, paren.index).trim() &&
    !/\b(?:or|approx\w*|about|maybe|perhaps|roughly)\b/i.test(paren[1]) &&
    (!/\d/.test(paren[1]) || /[*×x+\-\/=^]/.test(paren[1]))
  ) {
    r = r.slice(0, paren.index);
  }
  return r;
}

/** Remainder of the last 'Answer:' line in the visible reply (normalised), or null. */
function lastAnswerRemainder(text) {
  let last = null;
  for (const m of visibleAnswer(text).matchAll(ANSWER_LINE_RE)) {
    // A model that restates the instruction ("… a line 'Answer: <final number>'") has not answered
    // there: a placeholder in angle brackets is skipped, the last real line counts.
    if (/^\s*<[^>]*>/.test(m[1])) continue;
    last = m;
  }
  return last ? normalizeAnswerRemainder(last[1]) : null;
}

const toNum = (tok) => Number(tok.replace(/[,\u00a0\u202f]/g, ""));

/** @returns {{ first: number, second: number } | null} the two numbers of the last 'Answer:' line */
export function parseReasonAnswer(text) {
  const rest = lastAnswerRemainder(text);
  const m = rest == null ? null : rest.match(PAIR_FULL);
  return m ? { first: toNum(m[1]), second: toNum(m[2]) } : null;
}

export function scoreReason(item, reply) {
  const got = parseReasonAnswer(reply);
  // Suite v1 items named the pair jar/box; v2 shapes name it first/second.
  const want = { first: item.expected.first ?? item.expected.jar, second: item.expected.second ?? item.expected.box };
  return {
    ok: got != null && got.first === want.first && got.second === want.second,
    parsed: got ? `${got.first}, ${got.second}` : null,
    labeled: lastAnswerRemainder(reply) != null,
  };
}

const STEP_LINE_RE = /(?:^|\n)[\s*_`#>-]*step\s*(\d+)\s*[:=.)-]+[\s*_`$]*(-?[\d,]+)/gi;

/**
 * Suite v2 arithmetic: the final number as before, plus the share of 'Step n: <value>' lines that
 * match the expected intermediate values (the last line for each step counts).
 */
export function scoreArith(item, reply) {
  const single = scoreSingle(item, reply);
  const expected = Array.isArray(item.expectedSteps) ? item.expectedSteps : null;
  if (!expected) return single;
  /** @type {Map<number, number>} */
  const seen = new Map();
  for (const m of visibleAnswer(reply).matchAll(STEP_LINE_RE)) seen.set(Number(m[1]), toNum(m[2]));
  let correct = 0;
  expected.forEach((v, i) => {
    if (seen.get(i + 1) === v) correct += 1;
  });
  return { ...single, gradeCorrect: correct, gradeTotal: expected.length, detail: `${correct}/${expected.length} steps` };
}

/**
 * Suite v2 tracking: every person's total from the last 'Answer: Ana=<n>, Bo=<n>, …' line; passes
 * when all are right, graded by how many are.
 */
export function scoreTrack(item, reply) {
  if (typeof item.expected !== "object" || item.expected == null) return scoreSingle(item, reply);
  const rest = lastAnswerRemainder(reply);
  const names = Object.keys(item.expected);
  let correct = 0;
  const got = {};
  if (rest != null) {
    for (const name of names) {
      const m = rest.match(new RegExp(`${name}\\s*[=:]\\s*(-?[\\d,]+)`, "i"));
      if (m) {
        got[name] = toNum(m[1]);
        if (got[name] === item.expected[name]) correct += 1;
      }
    }
  }
  const parsed = Object.keys(got).length ? names.map((n) => `${n}=${got[n] ?? "?"}`).join(", ") : null;
  return { ok: correct === names.length, parsed, labeled: rest != null, gradeCorrect: correct, gradeTotal: names.length, detail: `${correct}/${names.length} people` };
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

/** Short name of a rule for the item table ("max-words 40", "forbid very, just"). */
export function followRuleName(rule) {
  const parts = [rule.kind];
  if (rule.n != null) parts.push(String(rule.n));
  if (Array.isArray(rule.w)) parts.push(rule.w.join(", "));
  else if (rule.w != null) parts.push(String(rule.w));
  return parts.join(" ");
}

export function scoreFollow(item, reply) {
  const text = visibleAnswer(reply);
  // Rules like max-words or forbid hold trivially for nothing: an empty reply is a failure.
  if (!text.trim()) return { ok: false, passed: 0, total: item.rules.length, failed: item.rules.map(followRuleName) };
  const failed = item.rules.filter((r) => !followCheck(r, text)).map(followRuleName);
  const passed = item.rules.length - failed.length;
  return { ok: failed.length === 0, passed, total: item.rules.length, failed };
}

// A line that commits to a letter: "Answer: B", "ANSWER: B", "**Answer: (B)**", "The correct answer
// is (B) foo", "Answer: B. Paris". The label is case-insensitive; a bare letter must be uppercase
// (so "Answer: a cat" is not A) and be followed by the end of the line or punctuation (so
// "Answer: A cat" is not A). A parenthesised letter may be followed by anything. Either way a
// hedge after it ("B or C", "B, C", "B / C") is rejected.
const MMLU_LABEL_RE = /\banswer\b[*\s]*(?::|is)/i;
const MMLU_LINE_RE =
  /\banswer\b[*\s]*(?::|is)[*\s"'`_]*(?:(?:option|choice)\s+)?(?:\(([A-Ja-j])\)|([A-J])(?![A-Za-z0-9]))[*\s"'`_]*(.*)$/i;
const MMLU_HEDGE_AFTER_RE =
  /^[\s,;/&]*(?:or|and|\/|&)\b|^\s*[,;/&]\s*(?:\(?[A-Ja-j]\)?(?![A-Za-z0-9])|but|though|however|also|maybe|perhaps)/i;

function mmluLetter(rawLine) {
  // Only the LaTeX / currency / minus normalisation: "(B)" is the answer here, not a working.
  const line = normalizeAnswerRemainder(rawLine, { paren: false });
  const m = line.match(MMLU_LINE_RE);
  if (!m) return null;
  const paren = m[1] != null;
  // The 'i' flag makes ([A-J]) match lowercase too; re-impose uppercase for the bare form.
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
  const final = normalizeAnswerRemainder([...lines].reverse().find((l) => l.trim()), { paren: false });
  const bare = final?.match(/^[*\s(]*([A-Ja-j])[*\s).:]*$/);
  if (bare) return bare[1].toUpperCase();
  // A final line that is the option itself: "C. 24", "C) Paris", "(C) Paris". The letter must be
  // uppercase and closed by "." or ")" so "A cat…" is not A.
  const option = final?.match(/^[*\s]*\(?([A-J])[.)]\s+\S/);
  return option ? option[1] : null;
}

/**
 * MATH answers in one canonical form: \boxed, $, \left/\right, \text, spaces, degree and percent
 * signs and a trailing period go; \dfrac/\tfrac become \frac and a simple \frac{a}{b} becomes a/b;
 * thousands commas inside a number go; a leading "x =" goes. Two numbers (plain or a/b) compare by value.
 * @param {string} s
 */
export function normalizeMathAnswer(s) {
  let r = String(s ?? "").trim();
  // \boxed{…} and the text wrappers go, with balanced braces (\boxed{\frac{3}{4}} nests them).
  for (let i = 0; i < 6; i++) {
    const m = r.match(/\\(?:boxed|text|textbf|mathrm|mathbf|mbox)\s*\{/);
    if (!m) break;
    const open = m.index + m[0].length;
    let depth = 1;
    let j = open;
    while (j < r.length && depth > 0) {
      if (r[j] === "{") depth += 1;
      else if (r[j] === "}") depth -= 1;
      j += 1;
    }
    if (depth !== 0) break;
    r = r.slice(0, m.index) + r.slice(open, j - 1) + r.slice(j);
  }
  r = r.replace(/\$/g, "").replace(/\\[dt]frac/g, "\\frac").replace(/\\left|\\right/g, "").replace(/\\[,;!: ]/g, "");
  r = r.replace(/\^\{?\\circ\}?/g, "").replace(/\\%|%/g, "").replace(/\\(?:cdot|times)/g, "*");
  for (let i = 0; i < 3; i++) r = r.replace(/\\frac\{([^{}]*)\}\{([^{}]*)\}/g, (m, a, b) => (/^[\w.\\]+$/.test(a) && /^[\w.\\]+$/.test(b) ? `${a}/${b}` : m));
  r = r.replace(/\\frac(\d)(\d)/g, "$1/$2");
  r = r.replace(/(\d),(?=\d{3}(?!\d))/g, "$1");
  r = r.replace(/\s+/g, "");
  r = r.replace(/^[a-z]\s*=\s*/i, "").replace(/^[a-z]\\in/i, "").replace(/\.$/, "").replace(/^\((-?[\w./\\]+)\)$/, "$1");
  r = r.replace(/^\{(.*)\}$/, "$1");
  return r;
}

function mathValue(s) {
  const frac = s.match(/^(-?\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)$/);
  if (frac) return Number(frac[1]) / Number(frac[2]);
  return /^-?\d+(?:\.\d+)?$/.test(s) ? Number(s) : null;
}

/** MATH-500: the last 'Answer:' line in canonical form against the reference. */
export function scoreMath(item, reply) {
  const rest = lastAnswerRemainder(reply);
  if (rest == null) return { ok: false, parsed: null, labeled: false };
  const got = normalizeMathAnswer(rest);
  const want = normalizeMathAnswer(item.expected);
  let ok = got !== "" && got === want;
  if (!ok) {
    const a = mathValue(got);
    const b = mathValue(want);
    if (a != null && b != null) ok = Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b));
  }
  return { ok, parsed: got || null, labeled: true };
}

export function scoreMmlu(item, reply) {
  const got = parseMmluAnswer(reply);
  return { ok: got === item.expected, parsed: got, labeled: MMLU_LABEL_RE.test(visibleAnswer(reply)) };
}

/** Score any item. */
export function scoreItem(item, reply) {
  switch (item.category) {
    case "qa":
    case "tokenizer":
      return scoreQa(item, reply);
    case "reason":
      return scoreReason(item, reply);
    case "arith":
      return scoreArith(item, reply);
    case "track":
      return scoreTrack(item, reply);
    case "gsm8k":
      return scoreSingle(item, reply);
    case "mmlu":
    case "mmlupro":
      return scoreMmlu(item, reply);
    case "math500":
      return scoreMath(item, reply);
    case "follow":
      return scoreFollow(item, reply);
    case "long":
      return scoreLong(item, reply);
    default:
      throw new Error(`scoreItem: ${item.category} is not text-scored`);
  }
}

/**
 * Per-category summary + overall (mean of category percentages). Unscored rows (a request
 * error, a reply truncated by max_tokens before its answer, a disputed item; see
 * qualityRowUnscored) are excluded from `passed`/`scored`/`pct` and counted in `errors`,
 * `truncated` and `disputed`; `total` is every row. A category with truncated rows is marked
 * `budgetLimited`: its pct covers only the replies that finished, so it is an upper-bound
 * reading of what the model does under this budget, not a clean score.
 * @param {Array<{ category: string, ok: boolean, completionTokens?: number, finishReason?: string | null, longCorrect?: number, longTotal?: number, longStale?: number, error?: string | null, disputed?: boolean | string | null }>} rows
 */
export function summarize(rows) {
  /** @type {Record<string, any>} */
  const categories = {};
  for (const r of rows) {
    const c =
      categories[r.category] ||
      (categories[r.category] = {
        passed: 0, total: 0, scored: 0, pct: null, errors: 0, truncated: 0, disputed: 0, budgetLimited: false,
        completionTokens: 0, hitMaxTokens: 0,
      });
    c.total += 1;
    const why = qualityRowUnscored(r);
    if (why === "error") c.errors += 1;
    else if (why === "truncated") {
      c.truncated += 1;
      c.budgetLimited = true;
    } else if (why === "disputed") c.disputed += 1;
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
    // Suite v2 grades (arithmetic steps, tracked people, long keys): a count beside the pass rate.
    if (why == null && Number(r.gradeTotal) > 0) {
      c.gradeCorrect = (c.gradeCorrect || 0) + (Number(r.gradeCorrect) || 0);
      c.gradeTotal = (c.gradeTotal || 0) + Number(r.gradeTotal);
    }
    if (r.category === "fidelity" && why == null) {
      // Token-weighted over the documents: the corpus NLL, not a mean of per-document means.
      const f = c.fidelity || (c.fidelity = { docs: 0, tokens: 0, bytes: 0, sumNll: 0, k: 0 });
      f.docs += 1;
      f.tokens += Number(r.tokens) || 0;
      f.bytes += Number(r.bytes) || 0;
      f.sumNll += Number(r.sumNll) || 0;
      f.k = Math.max(f.k, Number(r.k) || 0);
    }
  }
  const pcts = [];
  for (const [name, c] of Object.entries(categories)) {
    if (name === "divergence") {
      // Structural rates, no pass rate: reply identity measures sensitivity, not correctness.
      c.pct = null;
      c.coveragePct = c.total ? Math.round((c.scored / c.total) * 1000) / 10 : null;
      c.budgetedPct = null;
      c.ci = null;
      c.budgetedCi = null;
      c.meanCompletionTokens = c.total ? Math.round(c.completionTokens / c.total) : 0;
      delete c.completionTokens;
      c.divergence = divergenceRates(rows.filter((r) => r.category === "divergence"));
      continue;
    }
    if (name === "fidelity") {
      // No pass rate: the category reports NLL / perplexity and stays out of the overall.
      c.pct = null;
      c.coveragePct = c.total ? Math.round((c.scored / c.total) * 1000) / 10 : null;
      c.budgetedPct = null;
      c.ci = null;
      c.budgetedCi = null;
      c.meanCompletionTokens = 0;
      delete c.completionTokens;
      if (c.fidelity?.tokens) {
        const f = c.fidelity;
        f.nll = Math.round((f.sumNll / f.tokens) * 10000) / 10000;
        f.ppl = Math.round(Math.exp(f.sumNll / f.tokens) * 1000) / 1000;
        f.bitsPerByte = f.bytes ? Math.round((f.sumNll / Math.LN2 / f.bytes) * 10000) / 10000 : null;
      }
      continue;
    }
    c.pct = c.scored ? Math.round((c.passed / c.scored) * 1000) / 10 : null;
    // Coverage beside accuracy: how much of the category the score rests on, and the success rate
    // over everything that ran (a cut-off reply counts as not passed here), so a model that
    // truncates more cannot look better by shrinking the denominator.
    const ran = c.scored + c.truncated;
    c.coveragePct = c.total ? Math.round((c.scored / c.total) * 1000) / 10 : null;
    c.budgetedPct = ran ? Math.round((c.passed / ran) * 1000) / 10 : null;
    c.ci = wilsonInterval(c.passed, c.scored);
    c.budgetedCi = wilsonInterval(c.passed, ran);
    if (c.keysTotal) c.keysPct = Math.round((c.keysFound / c.keysTotal) * 1000) / 10;
    if (c.gradeTotal) c.gradePct = Math.round((c.gradeCorrect / c.gradeTotal) * 1000) / 10;
    c.meanCompletionTokens = c.total ? Math.round(c.completionTokens / c.total) : 0;
    delete c.completionTokens;
    if (c.pct != null) pcts.push(c.pct);
  }
  const overallPct = pcts.length ? Math.round((pcts.reduce((a, b) => a + b, 0) / pcts.length) * 10) / 10 : null;
  return { categories, overallPct };
}
