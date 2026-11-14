/**
 * WP2 fidelity: parsing prompt_logprobs, the item runner (injected fetch), the side files and the
 * run-to-run comparison. No network.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import fs from "fs";
import os from "os";
import path from "path";
import {
  compareFidelity,
  deleteFidelitySide,
  fidelityK,
  parsePromptLogprobs,
  pruneFidelitySides,
  readFidelitySide,
  runFidelityItem,
  writeFidelitySide,
} from "../qualityFidelity.js";
import { fidelityItems, loadFidelityCorpus, summarize } from "../qualitySuite.js";

/** A vLLM-shaped reply for `ids`: the actual token always present, top-K around it. */
function reply(ids, { lp = -1, topK = 3, bos = false, promptTokenIds = true } = {}) {
  const rows = [null];
  const positions = bos ? [null, ...ids] : ids;
  for (let i = 1; i < positions.length; i++) {
    const row = {};
    for (let j = 0; j < topK; j++) row[String(90000 + j)] = { logprob: -0.2 * (j + 1), rank: j + 1, decoded_token: `t${j}` };
    row[String(positions[i])] = { logprob: lp, rank: 7, decoded_token: "x" };
    rows.push(row);
  }
  return {
    choices: [{ text: " a", prompt_logprobs: rows, ...(promptTokenIds ? { prompt_token_ids: positions.map((v) => v ?? 1) } : {}) }],
    usage: { prompt_tokens: positions.length },
  };
}
const jsonResponse = (status, body) => ({ status, ok: status < 300, text: async () => JSON.stringify(body), json: async () => body });

test("the corpus is frozen with a version, a hash and 9 documents; items carry them", () => {
  const corpus = loadFidelityCorpus();
  assert.equal(corpus.version, 1);
  assert.equal(corpus.sha256.length, 64);
  assert.equal(corpus.docs.length, 9);
  const items = fidelityItems();
  assert.equal(items[0].id, "fid-prose-readme-a");
  assert.equal(items[0].category, "fidelity");
  assert.equal(items[0].corpusSha256, corpus.sha256);
  assert.ok(items[0].bytes >= items[0].chars);
  assert.ok(items.some((it) => it.lang === "zh-CN"));
});

test("fidelityK: the default, capped by the engine", () => {
  assert.equal(fidelityK(null), 20);
  assert.equal(fidelityK({ cap: 128 }), 20);
  assert.equal(fidelityK({ cap: 5 }), 5);
});

test("parsePromptLogprobs lines ids up with the rows, with and without an engine BOS", () => {
  const ids = [11, 22, 33, 44];
  const plain = parsePromptLogprobs(reply(ids).choices[0].prompt_logprobs, ids, 3);
  assert.deepEqual(plain.ids, [22, 33, 44]);
  assert.deepEqual(plain.lp, [-1, -1, -1]);
  assert.deepEqual(plain.rank, [7, 7, 7]);
  assert.equal(plain.top[0].length, 3);
  assert.deepEqual(plain.top[0][0], [90000, -0.2]);
  const withBos = parsePromptLogprobs(reply(ids, { bos: true }).choices[0].prompt_logprobs, ids, 3);
  assert.deepEqual(withBos.ids, [11, 22, 33, 44]);
  assert.match(parsePromptLogprobs(reply(ids).choices[0].prompt_logprobs, [1, 2], 3).error, /do not line up/);
  assert.match(parsePromptLogprobs(reply(ids).choices[0].prompt_logprobs, null, 3).error, /token ids unavailable/);
  const missing = reply(ids).choices[0].prompt_logprobs;
  delete missing[2]["33"];
  assert.match(parsePromptLogprobs(missing, ids, 3).error, /actual token \(id 33\) is missing from position 2/);
});

test("runFidelityItem scores a document and keeps the side data; /tokenize is the fallback for ids", async () => {
  const item = { id: "fid-x", docId: "x", kind: "prose", lang: "en", prompt: "a b c d", chars: 7, bytes: 7, docSha256: "abc" };
  const ids = [5, 6, 7, 8];
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(url);
    if (url.endsWith("/tokenize")) return jsonResponse(200, { tokens: ids });
    const body = JSON.parse(init.body);
    assert.equal(body.stream, false);
    assert.equal(body.max_tokens, 1);
    assert.equal(body.prompt_logprobs, 3);
    return jsonResponse(200, reply(ids, { lp: -0.5, promptTokenIds: false }));
  };
  const { row, side } = await runFidelityItem({ baseUrl: "http://x", modelId: "m", item, k: 3, fetchImpl });
  assert.equal(row.ok, true);
  assert.equal(row.tokens, 3);
  assert.equal(row.nll, 0.5);
  assert.equal(row.ppl, Math.round(Math.exp(0.5) * 1000) / 1000);
  assert.equal(row.sumNll, 1.5);
  assert.equal(row.top1Pct, 0);
  assert.equal(row.k, 3);
  assert.deepEqual(side.ids, [6, 7, 8]);
  assert.deepEqual(calls, ["http://x/v1/completions", "http://x/tokenize"]);

  const refused = await runFidelityItem({ baseUrl: "http://x", modelId: "m", item, k: 3, fetchImpl: async () => jsonResponse(400, { error: { message: "no logprobs" } }) });
  assert.equal(refused.row.ok, false);
  assert.match(refused.row.error, /HTTP 400: no logprobs/);
  assert.equal(refused.side, null);

  // summarize: token-weighted corpus statistics, no pass rate, out of the overall
  const rows = [row, { ...row, id: "fid-y", tokens: 1, sumNll: 2, bytes: 1 }, { id: "fid-z", category: "fidelity", ok: false, error: "boom" }];
  const s = summarize(rows);
  assert.equal(s.overallPct, null);
  assert.equal(s.categories.fidelity.pct, null);
  assert.equal(s.categories.fidelity.errors, 1);
  assert.equal(s.categories.fidelity.fidelity.docs, 2);
  assert.equal(s.categories.fidelity.fidelity.tokens, 4);
  assert.equal(s.categories.fidelity.fidelity.nll, 0.875);
  assert.equal(s.categories.fidelity.fidelity.ppl, Math.round(Math.exp(0.875) * 1000) / 1000);
});

test("side files: write, read, delete, prune", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "quality-fid-"));
  writeFidelitySide("run-a", { benchId: "run-a", docs: { x: { ids: [1], lp: [-1] } } }, dir);
  writeFidelitySide("run-b", { benchId: "run-b", docs: {} }, dir);
  assert.deepEqual(readFidelitySide("run-a", dir).docs.x.ids, [1]);
  assert.equal(readFidelitySide("none", dir), null);
  pruneFidelitySides(["run-a"], dir);
  assert.equal(readFidelitySide("run-b", dir), null);
  assert.ok(readFidelitySide("run-a", dir));
  deleteFidelitySide("run-a", dir);
  assert.equal(readFidelitySide("run-a", dir), null);
});

test("compareFidelity: ΔNLL with a document bootstrap, agreement, tail loss, divergence; mismatched tokenisation is not paired", () => {
  const doc = (ids, lpA, top) => ({ ids, lp: lpA, rank: lpA.map(() => 1), top });
  const topA = [[[1, -0.1], [2, -2.5]], [[3, -0.2], [4, -2.0]], [[5, -0.3], [6, -3.0]]];
  const topB = [[[1, -0.1], [2, -2.5]], [[4, -0.4], [3, -1.5]], [[7, -0.5], [5, -2.0]]];
  const a = { k: 2, corpusSha256: "c", docs: { d1: doc([10, 11, 12], [-1.0, -1.2, -0.8], topA), d2: doc([20, 21], [-2.0, -2.0], topA.slice(0, 2)), d3: doc([30, 31], [-1, -1], topA.slice(0, 2)) } };
  const b = { k: 2, corpusSha256: "c", docs: { d1: doc([10, 11, 12], [-0.9, -1.0, -0.8], topB), d2: doc([20, 21], [-2.0, -2.0], topB.slice(0, 2)), d3: doc([30, 99], [-1, -1], topB.slice(0, 2)) } };
  const out = compareFidelity(a, b);
  assert.equal(out.comparable, true);
  assert.equal(out.matchedDocs, 2);
  assert.equal(out.mismatchedDocs, 1);
  assert.equal(out.tokens, 5);
  // A: 1.0+1.2+0.8+2+2 = 7.0 ; B: 0.9+1.0+0.8+2+2 = 6.7 → ΔNLL 0.06 per token (A worse)
  assert.equal(out.dNll, 0.06);
  assert.equal(out.nllA, 1.4);
  assert.equal(out.nllB, 1.34);
  assert.ok(out.dNllCi[0] <= 0.06 && out.dNllCi[1] >= 0.06);
  // top-1: d1 positions agree at 0 only (1=1), differ at 1 (3 vs 4) and 2 (5 vs 7); d2 agrees at 0, differs at 1 → 2 of 5
  assert.equal(out.top1AgreementPct, 40);
  // tail loss: B's top-1 outside A's list — d1 pos 2 (7 not in {5,6}), nowhere else → 1 of 5
  assert.equal(out.tailLossPct, 20);
  assert.ok(out.divergence > 0);
  const d3 = out.docs.find((d) => d.id === "d3");
  assert.equal(d3.match, false);
  assert.equal(compareFidelity(a, null).comparable, false);
  assert.match(compareFidelity(a, { ...b, corpusSha256: "other" }).reason, /different corpus/);
  assert.equal(compareFidelity(a, a).dNll, 0);
  assert.equal(compareFidelity(a, a).top1AgreementPct, 100);
  assert.equal(compareFidelity(a, a).tailLossPct, 0);
  assert.equal(compareFidelity(a, a).divergence, 0);
});
