import test from "node:test";
import assert from "node:assert/strict";
import { generateSuite, scoreItem, followCheck } from "../qualitySuite.js";

const suite = () => generateSuite({ categories: ["follow"] });

test("follow suite is deterministic, JSON-safe and sized 40", () => {
  const a = suite();
  assert.equal(a.length, 40);
  assert.deepEqual(a, suite());
  assert.deepEqual(JSON.parse(JSON.stringify(a)), a);
  assert.ok(a.every((i) => i.thinking === false && i.rules.length >= 2 && i.prompt.includes(i.rules[0].text)));
});

test("no item asks for rules that cannot hold together", () => {
  for (const item of suite()) {
    const kinds = item.rules.map((r) => r.kind);
    assert.equal(new Set(kinds).size, kinds.length, item.id);
    if (kinds.includes("lowercase") || kinds.includes("uppercase")) {
      for (const bad of ["ends-with", "postscript", "include", "repeat", "title"]) assert.ok(!kinds.includes(bad), `${item.id} ${bad}`);
    }
    assert.ok(!(kinds.includes("min-words") && kinds.includes("max-words")), item.id);
    assert.ok(!(kinds.includes("quoted") && kinds.includes("ends-with")), `${item.id}: quotes vs exact ending`);
    assert.ok(!(kinds.includes("title") && kinds.filter((k) => k === "title").length > 1), item.id);
  }
});

test("each rule kind passes a conforming reply and fails a violating one", () => {
  const cases = [
    [{ kind: "min-words", n: 3 }, "one two three", "one two"],
    [{ kind: "max-words", n: 3 }, "one two", "one two three"],
    [{ kind: "bullets", n: 2 }, "* a\n* b", "* a\n* b\n* c"],
    [{ kind: "paragraphs", n: 2 }, "a\n***\nb", "a\nb"],
    [{ kind: "quoted" }, '"hi there"', "hi there"],
    [{ kind: "title" }, "<<Hello>>\nbody", "Hello\nbody"],
    [{ kind: "include", w: ["river", "garden"] }, "A River and a garden.", "A river only."],
    [{ kind: "repeat", w: "river", n: 2 }, "river river", "river"],
    [{ kind: "forbid", w: ["very", "just"] }, "plain text", "very plain"],
    [{ kind: "no-commas" }, "no commas here", "a, b"],
    [{ kind: "ends-with", e: "That is all for now." }, "x. That is all for now.", "That is all for now. x"],
    [{ kind: "postscript" }, "body\nP.S. more", "body"],
    [{ kind: "lowercase" }, "all lower", "Not lower"],
    [{ kind: "uppercase" }, "ALL UPPER 1", "Not UPPER"],
  ];
  for (const [rule, good, bad] of cases) {
    assert.equal(followCheck(rule, good), true, `${rule.kind} good`);
    assert.equal(followCheck(rule, bad), false, `${rule.kind} bad`);
  }
});

test("scoreItem needs every rule and ignores think spans", () => {
  const item = { category: "follow", rules: [{ kind: "no-commas" }, { kind: "max-words", n: 5 }] };
  assert.equal(scoreItem(item, "<think>a, b, c, d, e, f, g</think>short answer").ok, true);
  assert.equal(scoreItem(item, "short, answer").ok, false);
  const r = scoreItem(item, "one two three four five six");
  assert.deepEqual([r.ok, r.passed, r.total], [false, 1, 2]);
});
