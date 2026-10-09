/**
 * Quality bench: deterministic items, scoring (incl. GSM8K / MMLU subsets),
 * McNemar compare, and one end-to-end run against a fake OpenAI server.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import http from "http";
import os from "os";
import path from "path";
import fs from "fs";
import {
  buildLongPrompt,
  generateSuite,
  longItem,
  longSizesForContext,
  mulberry32,
  parseMmluAnswer,
  parseReasonAnswer,
  parseSingleAnswer,
  scoreItem,
  scoreLong,
  scoreQa,
  summarize,
  visibleAnswer,
} from "../qualitySuite.js";
import { QualityBenchManager, normalizeQualityOptions } from "../QualityBench.js";
import { compareQualityRuns, mcnemarExactP } from "../../../src/shared/qualityBench.js";

const ALL = ["qa", "reason", "arith", "track", "gsm8k", "mmlu", "follow", "long"];

// ─── Generation ──────────────────────────────────────────

test("mulberry32 is deterministic and in [0, 1)", () => {
  const a = mulberry32(42);
  const b = mulberry32(42);
  for (let i = 0; i < 1000; i++) {
    const x = a();
    assert.equal(x, b());
    assert.ok(x >= 0 && x < 1);
  }
});

test("suite is identical across generations (ids, prompts, answers)", () => {
  const opts = { categories: ALL, longSizes: [8192, 32768], longItems: 2 };
  const s1 = generateSuite(opts);
  const s2 = generateSuite(opts);
  assert.deepEqual(s1, s2);
  const l1 = s1.filter((i) => i.category === "long").map(buildLongPrompt);
  const l2 = s2.filter((i) => i.category === "long").map(buildLongPrompt);
  assert.deepEqual(l1, l2);
  const ids = s1.map((i) => i.id);
  assert.equal(new Set(ids).size, ids.length, "ids are unique");
});

test("category counts", () => {
  const s = generateSuite({ categories: ALL, longSizes: [8192, 16384], longItems: 3 });
  const count = (c) => s.filter((i) => i.category === c).length;
  assert.equal(count("qa"), 150);
  assert.equal(count("reason"), 40);
  assert.equal(count("arith"), 40);
  assert.equal(count("track"), 40);
  assert.equal(count("gsm8k"), 200);
  assert.equal(count("mmlu"), 285);
  assert.equal(count("follow"), 40);
  assert.equal(count("long"), 6);
  const qa = s.filter((i) => i.category === "qa");
  for (const prefix of ["fixed", "mul", "addsub", "rev", "count", "sort", "bin", "date", "lcm"]) {
    const n = qa.filter((i) => i.id.startsWith(`qa-${prefix}-`)).length;
    assert.equal(n, { fixed: 30, mul: 20, addsub: 15, rev: 15, count: 15, sort: 15, bin: 10, date: 15, lcm: 15 }[prefix], prefix);
  }
  assert.ok(qa.every((i) => i.maxTokens >= 64 && i.thinking === false));
  assert.ok(s.filter((i) => i.category === "reason").every((i) => i.maxTokens === 8192 && i.thinking));
  assert.ok(s.filter((i) => ["arith", "track"].includes(i.category)).every((i) => i.maxTokens === 12288 && i.thinking));
});

test("selecting a subset does not change another category's items", () => {
  const full = generateSuite({ categories: ALL, longSizes: [8192] });
  const onlyTrack = generateSuite({ categories: ["track"] });
  assert.deepEqual(onlyTrack, full.filter((i) => i.category === "track"));
});

test("generated qa answers are correct", () => {
  const qa = generateSuite({ categories: ["qa"] });
  for (const it of qa) {
    let m;
    if ((m = it.prompt.match(/^What is (\d+) \* (\d+)\?/))) assert.equal(it.accept[0], String(+m[1] * +m[2]));
    else if ((m = it.prompt.match(/^What is (\d+) \+ (\d+) - (\d+)\?/))) assert.equal(it.accept[0], String(+m[1] + +m[2] - +m[3]));
    else if ((m = it.prompt.match(/^Reverse the string '([a-z]+)'/))) assert.equal(it.accept[0], [...m[1]].reverse().join(""));
    else if ((m = it.prompt.match(/letter '(\w)' appear in the word '(\w+)'/))) assert.equal(it.accept[0], String(m[2].split(m[1]).length - 1));
    else if ((m = it.prompt.match(/binary representation of (\d+)\?/))) assert.equal(it.accept[0], Number(m[1]).toString(2));
    else if ((m = it.prompt.match(/^What date is (\d+) days after (\d{4}-\d{2}-\d{2})\?/))) {
      const d = new Date(`${m[2]}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() + Number(m[1]));
      assert.equal(it.accept[0], d.toISOString().slice(0, 10));
    } else if ((m = it.prompt.match(/least common multiple of (\d+) and (\d+)\?/))) {
      const [a, b] = [+m[1], +m[2]];
      let l = Math.max(a, b);
      while (l % a || l % b) l++;
      assert.equal(it.accept[0], String(l));
    }
  }
});

/** Independent re-simulation of an arith prompt. */
function simulateArith(prompt) {
  let v = Number(prompt.match(/^Start with (\d+)\./)[1]);
  for (const [, step] of prompt.matchAll(/\(\d+\) ([^;.]+(?:, [^;.]+)?)[;.]/g)) {
    let m;
    if ((m = step.match(/^multiply it by (\d+)/))) v *= +m[1];
    else if ((m = step.match(/^add (\d+)/))) v += +m[1];
    else if ((m = step.match(/^subtract (\d+)/))) v -= +m[1];
    else if ((m = step.match(/^replace it by its remainder when divided by (\d+), then add 1000/))) v = (v % +m[1]) + 1000;
    else if ((m = step.match(/^divide it by (\d+), rounding down/))) v = Math.floor(v / +m[1]);
    else throw new Error(`unparsed step: ${step}`);
  }
  return v;
}

/** Independent re-simulation of a track prompt. */
function simulateTrack(prompt) {
  const have = {};
  for (const [, p, n] of prompt.matchAll(/(\w+) starts with (\d+) tokens\./g)) have[p] = +n;
  const body = prompt.slice(prompt.lastIndexOf("tokens.") + 7, prompt.indexOf(" How many"));
  for (const sentence of body.split(/(?<=\.) /).map((x) => x.trim()).filter(Boolean)) {
    let m;
    if ((m = sentence.match(/^(\w+) gives half of their tokens \(rounded down\) to (\w+)\.$/))) {
      const g = Math.floor(have[m[1]] / 2);
      have[m[1]] -= g;
      have[m[2]] += g;
    } else if ((m = sentence.match(/^(\w+) gives (\d+) to (\w+)\.$/))) {
      have[m[1]] -= +m[2];
      have[m[3]] += +m[2];
    } else if ((m = sentence.match(/^(\w+) finds (\d+)\.$/))) have[m[1]] += +m[2];
    else throw new Error(`unparsed: ${sentence}`);
  }
  return have[prompt.match(/How many tokens does (\w+) have/)[1]];
}

test("arith: first item is hand-verifiable and every expected value re-simulates", () => {
  const items = generateSuite({ categories: ["arith"] });
  const first = items[0];
  assert.equal(first.id, "arith-01");
  assert.ok(
    first.prompt.startsWith(
      "Start with 557. Then, in order: (1) add 3542; (2) replace it by its remainder when divided by 3046, then add 1000;"
    )
  );
  // 557+3542=4099 → 4099%3046+1000=2053 → 2053%6350+1000=3053 → ×17=51901 → ⌊/7⌋=7414
  // → ×10=74140 → ⌊/8⌋=9267 → +1779=11046 → ×18=198828 → 198828%6115+1000=4148
  assert.equal(first.expected, 4148);
  assert.ok(first.prompt.endsWith("What is the final number? End your reply with a line 'Answer: <number>'."));
  for (const it of items) {
    assert.equal(simulateArith(it.prompt), it.expected, it.id);
    assert.ok(Number.isSafeInteger(it.expected));
  }
});

test("track: first item is hand-verifiable and every expected value re-simulates", () => {
  const items = generateSuite({ categories: ["track"] });
  const first = items[0];
  assert.equal(first.id, "track-01");
  assert.ok(
    first.prompt.startsWith(
      "Track the tokens carefully. Ana starts with 57 tokens. Bo starts with 33 tokens. Cy starts with 58 tokens. Di starts with 52 tokens. Ed starts with 34 tokens. Ana gives 4 to Ed."
    )
  );
  assert.ok(first.prompt.includes("How many tokens does Cy have at the end?"));
  assert.equal(first.expected, 32);
  for (const it of items) {
    assert.equal(simulateTrack(it.prompt), it.expected, it.id);
    assert.equal((it.prompt.match(/ starts with /g) || []).length, 5);
  }
});

test("reason: expected jar / per-box match the story arithmetic", () => {
  const items = generateSuite({ categories: ["reason"] });
  for (const it of items) {
    const m = it.prompt.match(
      /has (\d+) (\w+)\. \w+ has (\d+) times as many \w+ as \w+\. \w+ has (\d+) \w+\. \w+ gives (\d+) \w+ to \w+\. Then \w+ loses (\d+) \w+.*into (\d) boxes/
    );
    assert.ok(m, it.id);
    const [x, k, c, g, h, p] = [m[1], m[3], m[4], m[5], m[6], m[7]].map(Number);
    assert.ok(x >= 20 && x <= 90 && k >= 2 && k <= 5 && g >= 3 && g <= 15 && c >= 5 && c <= 40);
    assert.ok(h >= 2 && h <= Math.floor(x / 2) && [2, 3, 4].includes(p));
    const total = x - h + (k * x - g) + 2 * (c + g);
    assert.deepEqual(it.expected, { jar: total % p, box: Math.floor(total / p) });
  }
});

// ─── Scoring ─────────────────────────────────────────────

test("qa scoring: the reply must commit to the answer, not mention it", () => {
  const num = { category: "qa", mode: "number", accept: ["391"] };
  assert.equal(scoreQa(num, "391").ok, true);
  assert.equal(scoreQa(num, "**391**").ok, true);
  assert.equal(scoreQa(num, "17 * 23 = 391.").ok, true);
  assert.equal(scoreQa(num, "1391").ok, false); // superstring
  assert.equal(scoreQa(num, "391 or 5").ok, false); // hedge: last number is 5
  assert.equal(scoreQa(num, "none").ok, false);
  const big = { category: "qa", mode: "number", accept: ["1048576", "1,048,576"] };
  assert.equal(scoreQa(big, "1,048,576").ok, true);
  const neg = { category: "qa", mode: "number", accept: ["-1234", "-1,234"] };
  assert.equal(scoreQa(neg, "-1234").ok, true);
  assert.equal(scoreQa(neg, "1234").ok, false); // sign matters
  const dec = { category: "qa", mode: "number", accept: ["0.3"] };
  assert.equal(scoreQa(dec, "0.3").ok, true);
  assert.equal(scoreQa(dec, "0.30000000000000004").ok, false);

  const word = { category: "qa", mode: "word", accept: ["canberra"] };
  assert.equal(scoreQa(word, "The capital is Canberra.").ok, true);
  assert.equal(scoreQa(word, "Sydney").ok, false);
  assert.equal(scoreQa({ ...word, accept: ["au"] }, "Australia").ok, false); // whole word only
  assert.equal(scoreQa({ ...word, accept: ["au"] }, "Au").ok, true);
  assert.equal(scoreQa({ ...word, accept: ["yes"] }, "Eyes").ok, false);
  assert.equal(scoreQa({ ...word, accept: ["dlofrosnet"] }, "`dlofrosnet`").ok, true);
  assert.equal(scoreQa({ ...word, accept: ["dlofrosnet"] }, "dlofrosne").ok, false);
  assert.equal(scoreQa(word, "word ".repeat(30) + "canberra").ok, true); // long, but it ends on the answer
  assert.equal(scoreQa(word, "canberra " + "word ".repeat(30)).ok, false); // an essay that merely mentions it
  assert.equal(scoreQa(word, "Canberra or Sydney").ok, false); // hedge
  assert.equal(scoreQa({ ...word, accept: ["yrassecen"] }, "y-r-a-s-s-e-c-e-n so it is **yrassecen**").ok, true);
  // Strict 'last number' rule: leading with the answer then adding numbers does not commit.
  assert.equal(scoreQa({ category: "qa", mode: "number", accept: ["3"] }, "3 The list has three elements, 1, [2, 3] and 4.").ok, false);
  assert.equal(scoreQa({ category: "qa", mode: "number", accept: ["391"] }, "391. Correction: I made an error, it is 5").ok, false);
  assert.equal(scoreQa({ category: "qa", mode: "number", accept: ["3"] }, "3 or 4, then 5").ok, false);
  assert.equal(scoreQa(word, "<think>canberra? maybe</think>Sydney").ok, false);

  const list = { category: "qa", mode: "list", accept: ["1, 2, 4, 7, 9"] };
  assert.equal(scoreQa(list, "1, 2, 4, 7, 9").ok, true);
  assert.equal(scoreQa(list, "Sorted: 1,2,4,7,9.").ok, true);
  assert.equal(scoreQa(list, "11, 2, 4, 7, 9").ok, false);
  assert.equal(scoreQa(list, "9, 7, 4, 2, 1").ok, false);

  const date = { category: "qa", mode: "date", accept: ["2024-03-01"] };
  assert.equal(scoreQa(date, "2024-03-01").ok, true);
  assert.equal(scoreQa(date, "2024-03-01 or 2024-03-02").ok, false);

  // legacy saved modes still score
  assert.equal(scoreQa({ category: "qa", mode: "exact", accept: ["4"] }, "Counting 1, 2, 3, 4 — so 4.").ok, true);
  assert.equal(scoreQa({ category: "qa", mode: "exact", accept: ["1101"] }, "0b1101").ok, true);
});

test("qa suite: unique prompts, answers verified independently, own answer always passes", () => {
  const items = generateSuite({ categories: ["qa"] });
  assert.equal(items.length, 150);
  assert.equal(new Set(items.map((i) => i.id)).size, items.length);
  assert.equal(new Set(items.map((i) => i.prompt)).size, items.length);
  const gcd = (a, b) => (b ? gcd(b, a % b) : a);
  for (const it of items) {
    for (const a of it.accept) assert.equal(scoreItem(it, a).ok, true, `${it.id} rejects its own answer ${a}`);
    let m;
    if ((m = it.prompt.match(/appear in the word '(\w+)'/))) {
      const ch = it.prompt.match(/letter '(.)'/)[1];
      assert.equal(String([...m[1]].filter((c) => c === ch).length), it.accept[0], it.id);
    }
    if ((m = it.prompt.match(/least common multiple of (\d+) and (\d+)/))) {
      assert.equal(String((+m[1] * +m[2]) / gcd(+m[1], +m[2])), it.accept[0], it.id);
    }
    if (it.id.startsWith("qa-bin") && (m = it.prompt.match(/representation of (\d+)/))) {
      assert.equal((+m[1]).toString(2), it.accept[0], it.id);
    }
    if ((m = it.prompt.match(/What date is (\d+) days after (\S+)\?/))) {
      assert.equal(new Date(Date.parse(m[2]) + m[1] * 864e5).toISOString().slice(0, 10), it.accept[0], it.id);
    }
    if ((m = it.prompt.match(/^What is (\d+) \* (\d+)\?/))) assert.equal(+it.accept[0], m[1] * m[2], it.id);
    if ((m = it.prompt.match(/^What is (\d+) \+ (\d+) - (\d+)\?/))) assert.equal(+it.accept[0], +m[1] + +m[2] - +m[3], it.id);
    if ((m = it.prompt.match(/^Reverse the string '(\w+)'/))) assert.equal(it.accept[0], [...m[1]].reverse().join(""), it.id);
  }
  // No item can be passed by mentioning its answer inside a longer number or a hedge.
  for (const it of items.filter((i) => i.mode === "number")) {
    assert.equal(scoreItem(it, `1${it.accept[0]}`).ok, false, `${it.id} superstring`);
    assert.equal(scoreItem(it, `${it.accept[0]} or 7777777`).ok, false, `${it.id} hedge`);
  }
});


test("reason scoring: last 'Answer: J, B', markdown tolerated, content only", () => {
  assert.deepEqual(parseReasonAnswer("blah\nAnswer: 3, 77"), { jar: 3, box: 77 });
  assert.deepEqual(parseReasonAnswer("**Answer:** **3**, **77**"), { jar: 3, box: 77 });
  assert.deepEqual(parseReasonAnswer("Answer: 1, 2\n...recheck...\nanswer: 3, 77"), { jar: 3, box: 77 });
  assert.equal(parseReasonAnswer("jar 3, box 77"), null);
  const item = { category: "reason", expected: { jar: 3, box: 77 } };
  assert.equal(scoreItem(item, "Answer: 3, 77").ok, true);
  assert.equal(scoreItem(item, "Answer: 77, 3").ok, false);
  assert.equal(scoreItem(item, "<think>Answer: 3, 77</think>Answer: 0, 0").ok, false);
});

test("arith/track scoring: last 'Answer: N', markdown + thousands commas", () => {
  assert.equal(parseSingleAnswer("Answer: 4148"), 4148);
  assert.equal(parseSingleAnswer("**Answer:** **198,828**"), 198828);
  assert.equal(parseSingleAnswer("Answer: 5\nWait.\nAnswer: -12"), -12);
  assert.equal(parseSingleAnswer("the answer is 7"), null);
  const item = { category: "arith", expected: 4148 };
  assert.equal(scoreItem(item, "...\n**Answer: 4,148**").ok, true);
  assert.equal(scoreItem(item, "Answer: 4149").ok, false);
  assert.equal(scoreItem({ category: "track", expected: 32 }, "Answer: 32").ok, true);
});

test("long: prompt contains facts + corrections in order; scoring counts stale", () => {
  const item = longItem(8192, 1);
  assert.equal(item.id, "long-8k-1");
  assert.equal(item.facts.length, 16);
  const corrected = item.facts.filter((f) => f.corrected);
  assert.equal(corrected.length, 4);
  const prompt = buildLongPrompt(item);
  for (const f of item.facts) {
    const at = prompt.indexOf(`Remember this: the code for ${f.name} is ${f.code}.`);
    assert.ok(at >= 0 && at < prompt.length * 0.72, f.name);
    if (f.corrected) {
      const fix = prompt.indexOf(`Correction: the code for ${f.name} has changed, it is now ${f.corrected}.`);
      assert.ok(fix > prompt.length * 0.68, `${f.name} correction in the last 30%`);
    }
  }
  assert.ok(prompt.includes("use the latest value for each"));
  const words = prompt.split(/\s+/).length;
  assert.ok(words > 8192 * 0.72 * 0.9 && words < 8192 * 0.72 * 1.1, `~0.72 words/token (${words})`);

  const latest = (f) => f.corrected || f.code;
  const perfect = item.askOrder.map((n) => `${n}: ${latest(item.facts.find((f) => f.name === n))}`).join("\n");
  assert.deepEqual(scoreLong(item, perfect), { ok: true, correct: 16, total: 16, stale: 0 });

  const staleReply = item.facts.map((f) => `**${f.name}**: ${f.code}`).join("\n");
  assert.deepEqual(scoreLong(item, staleReply), { ok: false, correct: 12, total: 16, stale: 4 });

  const missing = item.facts.slice(0, 10).map((f) => `${f.name}: ${latest(f)}`).join("\n");
  const r = scoreLong(item, missing);
  assert.equal(r.correct, 10);
  assert.equal(r.ok, false);
});

test("long sizes above the known context are skipped", () => {
  assert.deepEqual(longSizesForContext([8192, 32768, 131072], 32768), { run: [8192], skipped: [32768, 131072] });
  assert.deepEqual(longSizesForContext([8192, 32768], 40960), { run: [8192, 32768], skipped: [] });
  assert.deepEqual(longSizesForContext([262144], null), { run: [262144], skipped: [] });
});

test("summarize: per-category %, overall = mean of category %, long keys + stale", () => {
  const rows = [
    { category: "qa", ok: true },
    { category: "qa", ok: false },
    { category: "reason", ok: true, completionTokens: 100, finishReason: "stop" },
    { category: "reason", ok: false, completionTokens: 300, finishReason: "length" },
    { category: "reason", ok: true, completionTokens: 200, finishReason: "stop" },
    { category: "reason", ok: true, completionTokens: 200, finishReason: "stop" },
    { category: "long", ok: false, longCorrect: 12, longTotal: 16, longStale: 3 },
  ];
  const s = summarize(rows);
  assert.equal(s.categories.qa.pct, 50);
  assert.equal(s.categories.reason.pct, 75);
  assert.equal(s.categories.reason.meanCompletionTokens, 200);
  assert.equal(s.categories.reason.hitMaxTokens, 1);
  assert.equal(s.categories.long.keysFound, 12);
  assert.equal(s.categories.long.keysTotal, 16);
  assert.equal(s.categories.long.stale, 3);
  assert.equal(s.overallPct, Math.round(((50 + 75 + 0) / 3) * 10) / 10);
});

// ─── GSM8K / MMLU subsets ────────────────────────────────

test("GSM8K and MMLU subsets: sizes, ids, shape and 5 questions for each of 57 subjects", () => {
  const s = generateSuite({ categories: ["gsm8k", "mmlu"] });
  const g = s.filter((i) => i.category === "gsm8k");
  const m = s.filter((i) => i.category === "mmlu");
  assert.equal(g.length, 200);
  assert.equal(m.length, 285);
  assert.equal(new Set(s.map((i) => i.id)).size, s.length);
  assert.ok(g.every((i) => Number.isInteger(i.expected) && i.thinking === true && /^gsm8k-\d{4}$/.test(i.id)));
  assert.ok(m.every((i) => /^[ABCD]$/.test(i.expected) && i.thinking === false && /\nA\. .+\nB\. .+\nC\. .+\nD\. /s.test(i.prompt)));
  const perSubject = new Map();
  for (const i of m) perSubject.set(i.subject, (perSubject.get(i.subject) || 0) + 1);
  assert.equal(perSubject.size, 57);
  assert.ok([...perSubject.values()].every((n) => n === 5));
  assert.deepEqual(generateSuite({ categories: ["gsm8k", "mmlu"] }), s);
});

test("GSM8K scoring accepts $, commas and markdown around the final number", () => {
  const item = { category: "gsm8k", expected: 1234 };
  for (const r of ["Answer: 1234", "**Answer:** $1,234", "work\nAnswer: 1234.00", "<think>Answer: 5</think>Answer: 1,234"]) {
    assert.equal(scoreItem(item, r).ok, true, r);
  }
  assert.equal(scoreItem(item, "Answer: 1235").ok, false);
  assert.equal(scoreItem(item, "no answer line").ok, false);
});

test("MMLU answer parsing: Answer line, bare letter, think spans; never guesses from prose", () => {
  assert.equal(parseMmluAnswer("Because X.\nAnswer: C"), "C");
  assert.equal(parseMmluAnswer("**Answer:** (b)"), "B");
  assert.equal(parseMmluAnswer("D."), "D");
  assert.equal(parseMmluAnswer("<think>Answer: A</think>B"), "B");
  assert.equal(parseMmluAnswer("I think the answer is probably C because A and B fail"), null);
  assert.equal(scoreItem({ category: "mmlu", expected: "C" }, "Answer: C").ok, true);
  assert.equal(scoreItem({ category: "mmlu", expected: "C" }, "Answer: B").ok, false);
});

// ─── McNemar + compare ───────────────────────────────────

test("mcnemarExactP matches the exact binomial formula", () => {
  assert.equal(mcnemarExactP(0, 0), 1);
  assert.equal(mcnemarExactP(5, 5), 1);
  assert.equal(mcnemarExactP(0, 1), 1);
  // n=5, k=0 → 2/32
  assert.ok(Math.abs(mcnemarExactP(0, 5) - 0.0625) < 1e-12);
  // n=10, k=1 → 2*(1+10)/1024
  assert.ok(Math.abs(mcnemarExactP(1, 9) - 22 / 1024) < 1e-12);
  assert.ok(Math.abs(mcnemarExactP(9, 1) - 22 / 1024) < 1e-12);
  // n=12, k=2 → 2*(1+12+66)/4096
  assert.ok(Math.abs(mcnemarExactP(2, 10) - 158 / 4096) < 1e-12);
  // Large n stays finite and symmetric.
  const p = mcnemarExactP(60, 90);
  assert.ok(p > 0 && p < 0.05);
  assert.equal(p, mcnemarExactP(90, 60));
});

test("compareQualityRuns pairs by id and counts discordant items", () => {
  const mk = (oks, hashes) => ({
    results: {
      categories: { qa: { passed: oks.filter(Boolean).length, total: oks.length, pct: 0 } },
      items: oks.map((ok, i) => ({ id: `qa-${i}`, category: "qa", ok, hash: hashes[i] })),
    },
  });
  const a = mk([true, true, false, false, true], ["h0", "h1", "h2", "x", "h4"]);
  const b = mk([true, false, true, false, false], ["h0", "y1", "y2", "x", "y4"]);
  b.results.items.push({ id: "qa-extra", category: "qa", ok: true, hash: "z" });
  const [row] = compareQualityRuns(a, b);
  assert.equal(row.category, "qa");
  assert.equal(row.paired, 5);
  assert.equal(row.identical, 2);
  assert.equal(row.onlyA, 2);
  assert.equal(row.onlyB, 1);
  assert.equal(row.bothOk, 1);
  assert.equal(row.bothFail, 1);
  assert.equal(row.p, mcnemarExactP(2, 1));
  assert.equal(row.withinNoise, true);
});

// ─── Manager gates + end-to-end against a fake server ────

test("normalizeQualityOptions clamps and defaults", () => {
  const d = normalizeQualityOptions({});
  assert.deepEqual(d.categories, ["qa", "reason", "arith", "track", "gsm8k", "mmlu"]);
  assert.deepEqual(d.longSizes, []);
  assert.equal(d.concurrency, 4);
  const o = normalizeQualityOptions({
    categories: ["long", "bogus"],
    longSizes: [999, 65536],
    longItems: 99,
    concurrency: 500,
    label: "  fp4   KV  ",
  });
  assert.deepEqual(o.categories, ["long"]);
  assert.deepEqual(o.longSizes, [65536]);
  assert.equal(o.longItems, 5);
  assert.equal(o.concurrency, 16);
  assert.equal(o.label, "fp4 KV");
});

function tmpManager() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "quality-bench-"));
  return {
    dir,
    mgr: new QualityBenchManager(path.join(dir, "hist.json"), path.join(dir, "active.json")),
  };
}

test("QualityBenchManager.start rejects empty categories and overlapping jobs", () => {
  const { mgr } = tmpManager();
  assert.throws(
    () => mgr.start({ sparkId: "s1", lanIp: "127.0.0.1", port: 8888, modelId: "m", categories: [] }),
    /at least one category/i
  );
  mgr.activeBySpark.set("s1", "fake-id");
  assert.throws(
    () => mgr.start({ sparkId: "s1", lanIp: "127.0.0.1", port: 8888, modelId: "m" }),
    /already running/i
  );
});

test("QualityBenchManager recovers a leftover active checkpoint as interrupted", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "quality-bench-"));
  const active = path.join(dir, "active.json");
  fs.writeFileSync(
    active,
    JSON.stringify({
      jobs: [{ benchId: "b1", sparkId: "s1", status: "running", startedAt: 1, config: { port: 8888 }, progress: {}, results: { items: [] } }],
    })
  );
  const mgr = new QualityBenchManager(path.join(dir, "hist.json"), active);
  const job = mgr.getJob("b1");
  assert.equal(job.status, "failed");
  assert.match(job.error, /Interrupted/);
  assert.deepEqual(JSON.parse(fs.readFileSync(active, "utf8")).jobs, []);
});

/** Minimal OpenAI-compatible SSE server answering from a prompt → reply map. */
function fakeServer(answerFor, seen) {
  const server = http.createServer((req, res) => {
    if (req.url === "/v1/models") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ data: [{ id: "fake-model", max_model_len: 16384 }] }));
      return;
    }
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      const body = JSON.parse(raw);
      seen.push(body);
      const content = answerFor(body.messages[0].content);
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ model: "fake-model", choices: [{ delta: { content } }] })}\n\n`);
      res.write(
        `data: ${JSON.stringify({ model: "fake-model", choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`
      );
      res.end("data: [DONE]\n\n");
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

test("end-to-end: fake server, perfect answers except one, long size skipped by context", async () => {
  const suite = generateSuite({ categories: ["qa", "track", "mmlu", "long"], longSizes: [8192], longItems: 1 });
  const byPrompt = new Map();
  for (const it of suite) {
    if (it.category === "long") {
      const latest = it.facts.map((f) => `${f.name}: ${f.corrected || f.code}`).join("\n");
      byPrompt.set(buildLongPrompt(it), latest);
    } else if (it.category === "qa") byPrompt.set(it.prompt, it.id === "qa-fixed-01" ? "390" : it.accept[0]);
    else if (it.category === "track") byPrompt.set(it.prompt, `Working…\n**Answer:** ${it.expected}`);
    else byPrompt.set(it.prompt, `Reasoning.\nAnswer: ${it.expected}`);
  }
  const seen = [];
  const server = await fakeServer((p) => byPrompt.get(p) ?? "??", seen);
  const { mgr } = tmpManager();
  try {
    const started = mgr.start({
      sparkId: "s1",
      lanIp: "127.0.0.1",
      port: server.address().port,
      modelId: null,
      categories: ["qa", "track", "mmlu", "long"],
      longSizes: [8192, 32768],
      longItems: 1,
      concurrency: 8,
      label: "fake",
    });
    let job = started;
    for (let i = 0; i < 600 && job.status === "running"; i++) {
      await new Promise((r) => setTimeout(r, 50));
      job = mgr.getJob(started.benchId);
    }
    assert.equal(job.status, "completed", job.error || "");
    assert.equal(job.config.modelId, "fake-model");
    assert.equal(job.config.contextLength, 16384);
    assert.deepEqual(job.results.skippedLongSizes, [32768]);
    assert.equal(job.results.items.length, 150 + 40 + 285 + 1);
    assert.equal(job.results.items[0].id, "qa-fixed-01", "items kept in suite order");
    assert.equal(job.results.categories.qa.passed, 149);
    assert.equal(job.results.categories.track.passed, 40);
    assert.equal(job.results.categories.mmlu.passed, 285);
    assert.equal(job.results.categories.long.passed, 1);
    assert.equal(job.results.categories.long.keysFound, 16);
    assert.equal(job.results.categories.qa.pct, 99.3);
    assert.equal(job.results.overallPct, 99.8);
    const req = seen.find((b) => b.messages[0].content.startsWith("Track the tokens"));
    assert.equal(req.temperature, 0);
    assert.equal(req.seed, 1234);
    assert.equal(req.max_tokens, 12288);
    assert.equal(req.chat_template_kwargs.enable_thinking, true);
    const qaReq = seen.find((b) => b.messages[0].content.startsWith("What is 17 * 23"));
    assert.equal(qaReq.chat_template_kwargs.enable_thinking, false);
    assert.equal(qaReq.max_tokens, 64);
    // History persisted with per-item hashes; summaries drop the rows.
    assert.equal(mgr.getHistory("s1")[0].results.items[0].hash.length, 16);
    assert.equal(mgr.getHistorySummaries("s1")[0].results.items, undefined);
    assert.equal(mgr.activeCount(), 0);
  } finally {
    server.close();
  }
});

test("single and pair answers must be exactly the answer line (no hedges, no truncated decimals)", () => {
  const one = { category: "arith", expected: 1200 };
  const pass = ["Answer: 1200", "**Answer: 1200**", "Answer: $1,200", "Answer: 1200.0", "Answer: 1200.", "Answer: `1200`", "work\nAnswer: 5\nAnswer: 1200"];
  const fail = ["Answer: 1200.9", "Answer: 1200 or 1201", "Answer: 1200,5", "Answer: 1,23", "Answer: 1200 / 1300", "The answer is 1200", "<think>Answer: 1200</think>Answer: 0"];
  for (const r of pass) assert.equal(scoreItem(one, r).ok, true, r);
  for (const r of fail) assert.equal(scoreItem(one, r).ok, false, r);
  const two = { category: "reason", expected: { jar: 3, box: 77 } };
  for (const r of ["Answer: 3, 77", "**Answer: 3, 77**", "Answer: 3,77", "Answer: 3, 77."]) assert.equal(scoreItem(two, r).ok, true, r);
  for (const r of ["Answer: 3, 77, 4", "Answer: 3, 77.5", "Answer: 3, 77 or 3, 78", "Answer: 77, 3"]) assert.equal(scoreItem(two, r).ok, false, r);
});

test("follow: an empty reply never passes, markdown markers are not words, underscores are not word characters", () => {
  const trivial = { category: "follow", rules: [{ kind: "max-words", n: 50 }, { kind: "forbid", w: ["very"] }] };
  assert.equal(scoreItem(trivial, "").ok, false);
  assert.equal(scoreItem(trivial, "<think>x</think>").ok, false);
  assert.equal(scoreItem(trivial, "short and fine").ok, true);
  const bullets = { category: "follow", rules: [{ kind: "bullets", n: 3 }, { kind: "max-words", n: 7 }] };
  assert.equal(scoreItem(bullets, "* a\n* b\n* c").ok, true); // 3 words, not 6
  assert.equal(scoreItem({ category: "follow", rules: [{ kind: "bullets", n: 2 }] }, "- a\n- b").ok, false);
  assert.equal(scoreItem({ category: "follow", rules: [{ kind: "include", w: ["garden"] }] }, "a _garden_ path").ok, true);
  assert.equal(scoreItem({ category: "follow", rules: [{ kind: "forbid", w: ["very"] }] }, "a _very_ path").ok, false);
});

test("long: corrections phrased naturally still score as correct, several names on one line work", () => {
  const item = {
    category: "long",
    facts: [
      { name: "otter", code: "48213", corrected: "90471" },
      { name: "heron", code: "11111", corrected: null },
      { name: "lynx", code: "22222", corrected: null },
    ],
  };
  assert.deepEqual(scoreLong(item, "otter: 90471 (was 48213)\nheron: 11111\nlynx: 22222"), { ok: true, correct: 3, total: 3, stale: 0 });
  assert.equal(scoreLong(item, "otter: 90471\nheron: 11111\nlynx: 22222\nNote: otter was originally 48213").ok, true);
  assert.equal(scoreLong(item, "otter: 90471, heron: 11111, lynx: 22222").ok, true);
  assert.equal(scoreLong(item, "otter: 48213 -> 90471\nheron: 11111\nlynx: 22222").ok, true);
  const stale = scoreLong(item, "otter: 48213\nheron: 11111\nlynx: 22222");
  assert.equal(stale.ok, false);
  assert.equal(stale.stale, 1);
});

test("long sizes keep 20% headroom for tokenizers that need more tokens than nominal", () => {
  assert.deepEqual(longSizesForContext([65536], 70000), { run: [], skipped: [65536] });
  assert.deepEqual(longSizesForContext([65536], 131072), { run: [65536], skipped: [] });
});

test("MMLU: commits to a letter at the end of a line; hedges, articles and mid-prose mentions do not count", () => {
  const ok = { "The answer is (B)": "B", "The answer is B.": "B", "Answer: Option C": "C", "**Answer: D**": "D", "Answer: `A`": "A", "reasoning\n\n**C**": "C", "Answer: B\nNote: the answer: a classic result.": "B" };
  for (const [r, want] of Object.entries(ok)) assert.equal(parseMmluAnswer(r), want, r);
  for (const r of ["Answer: a cat", "Answer: A or B", "Answer: B/C", "Answer: A, but also B", "Answer is probably C because"]) {
    assert.equal(parseMmluAnswer(r), null, r);
  }
});

test("scoring version is exported and bumped past the original parsers", async () => {
  const { SCORING_VERSION, SUITE_VERSION } = await import("../qualitySuite.js");
  assert.ok(SCORING_VERSION >= 2);
  assert.equal(typeof SUITE_VERSION, "number");
});

test("MMLU parser takes case-insensitive labels and trailing text after the letter", () => {
  for (const r of ["Answer: B. Paris", "ANSWER: B", "The correct answer is (B) foo", "answer: (c) because", "**Answer:** B) Paris", "Answer: D - Paris"]) {
    assert.ok(parseMmluAnswer(r), r);
  }
  assert.equal(parseMmluAnswer("Answer: B. Paris"), "B");
  assert.equal(parseMmluAnswer("ANSWER: C"), "C");
  assert.equal(parseMmluAnswer("The correct answer is (B) foo"), "B");
  for (const r of ["Answer: A cat", "Answer: B Paris", "Answer: A or B", "Answer: (A) or (B)"]) assert.equal(parseMmluAnswer(r), null, r);
  // detail message distinguishes a missing label from an unreadable one
  assert.equal(scoreItem({ category: "mmlu", expected: "B" }, "I do not know").labeled, false);
  assert.equal(scoreItem({ category: "mmlu", expected: "B" }, "Answer: A or B").labeled, true);
});

test("GSM8K / single answers accept %, currency, unit suffixes and thousands separators", () => {
  const g = (n) => ({ category: "gsm8k", expected: n });
  for (const [r, n] of [
    ["Answer: 25%", 25],
    ["Answer: 18 dollars", 18],
    ["ANSWER: $1,234.50", 1234.5],
    ["answer: 12 square feet.", 12],
    ["**Answer:** 1,234 dollars", 1234],
    ["Answer: 1\u202f234", 1234],
  ]) assert.equal(scoreItem(g(n), r).ok, true, r);
  for (const r of ["Answer: 5 or 6", "Answer: 32, 33", "Answer: 5 is wrong"]) assert.equal(parseSingleAnswer(r), null, r);
  assert.equal(scoreItem(g(5), "Answer: five").labeled, true);
  assert.equal(scoreItem(g(5), "it is 5").labeled, false);
});

test("QA word mode rejects negation next to the token", () => {
  const word = { category: "qa", mode: "word", accept: ["canberra"] };
  assert.equal(scoreQa(word, "Not canberra").ok, false);
  assert.equal(scoreQa(word, "Canberra is wrong").ok, false);
  assert.equal(scoreQa(word, "Canberra, not Sydney").ok, true);
  assert.equal(scoreQa({ ...word, accept: ["yes"] }, "No, not yes").ok, false);
  assert.equal(scoreQa({ ...word, accept: ["yes"] }, "Yes").ok, true);
  assert.equal(scoreQa({ ...word, accept: ["no"] }, "No").ok, true);
});

test("summarize excludes request errors from passed/pct and reports them", () => {
  const { categories, overallPct } = summarize([
    { category: "qa", ok: true },
    { category: "qa", ok: false },
    { category: "qa", ok: false, error: "Timed out" },
    { category: "qa", ok: false, error: "HTTP 500" },
    { category: "mmlu", ok: false, error: "x" },
  ]);
  assert.equal(categories.qa.total, 4);
  assert.equal(categories.qa.scored, 2);
  assert.equal(categories.qa.errors, 2);
  assert.equal(categories.qa.pct, 50);
  assert.equal(categories.mmlu.pct, null);
  assert.equal(overallPct, 50);
});
