import assert from "node:assert/strict";
import test from "node:test";
import { scanUiText, applyExceptions } from "../i18n-coverage.mjs";

test("finds visible JSX, attributes, conditional labels, templates and menu definitions", () => {
  const source = 'const menu = [{label:"Clear history",ask:"Delete everything?"}]; const head = `Results for ${name}`; function View(){return <button title="Delete data" aria-label={busy ? "Deleting" : "Delete"}>{ready && "Run now"}Cancel</button>}';
  const texts = scanUiText(source, "src/View.tsx").map(x => x.text);
  for (const text of ["Clear history", "Delete everything?", "Results for {…}", "Delete data", "Deleting", "Delete", "Run now", "Cancel"]) assert.ok(texts.includes(text), text);
});

test("does not mistake comparison values, CSS, comments or translation defaults for displayed English", () => {
  const source = '// English comment\n const path = "/api/start"; function V(){return <div className="panel card" data-status="running">{kind === "host" && t("ui.host", "GPU host")}</div>}';
  assert.deepEqual(scanUiText(source, "src/View.tsx"), []);
});

test("finds untranslated branches without inspecting a translated sibling's defaults", () => {
  const source = 'function V(){return <div>{ok ? t("ui.ok", "All good") : "Something failed"}</div>}';
  assert.deepEqual(scanUiText(source, "src/View.tsx").map(x => x.text), ["Something failed"]);
});

test("exceptions bind exact file, syntax and text, and require a rationale", () => {
  const findings = scanUiText('const x=<div>GPU</div>', "src/View.tsx");
  const exception = { file: "src/View.tsx", kind: "jsx", text: "GPU", reason: "Technical abbreviation" };
  assert.equal(applyExceptions(findings, [exception]).untranslated.length, 0);
  assert.equal(applyExceptions(scanUiText('const x=<div>GPU status</div>', "src/View.tsx"), [exception]).untranslated.length, 1);
  assert.ok(applyExceptions(findings, [{...exception, file:"src/*"}]).errors.length);
  assert.ok(applyExceptions(findings, [{...exception, reason:""}]).errors.length);
  assert.ok(applyExceptions([], [exception]).errors.some(x=>x.includes("Stale")));
});

test("handles TypeScript and multiline JSX without rewriting source", () => {
  const text = 'const n: number=1;\nconst x=<p>\n  Nothing to show\n</p>';
  const result = scanUiText(text, "src/View.tsx");
  assert.equal(result[0].text, "Nothing to show");
  assert.equal(result[0].line, 2);
});

test("finds named error state and permits exact protocol text containing operators", () => {
  const findings = scanUiText('setSnapshotError("Invalid telemetry"); const x=<code>2 * GB</code>', "src/View.tsx");
  assert.ok(findings.some(x => x.kind === "feedback" && x.text === "Invalid telemetry"));
  const exception = {file: "src/View.tsx", kind: "jsx", text: "2 * GB", reason: "Exact arithmetic unit expression"};
  assert.deepEqual(applyExceptions(findings, [exception]).errors, []);
});
