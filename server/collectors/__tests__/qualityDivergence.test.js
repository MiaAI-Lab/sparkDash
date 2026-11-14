/** WP3 divergence: the prompt set, the structural checks and the runner (injected fetch). */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { checkJson, checkToolCall, divergenceItems, runDivergenceItem } from "../qualityDivergence.js";
import { summarize } from "../qualitySuite.js";

const jsonResponse = (status, body) => ({ status, ok: status < 300, text: async () => JSON.stringify(body), json: async () => body });
const chat = (content, extra = {}, usage = { prompt_tokens: 20, completion_tokens: 50 }) =>
  jsonResponse(200, { choices: [{ message: { role: "assistant", content, ...extra }, finish_reason: extra.finish_reason ?? "stop" }], usage });

test("divergenceItems: 120 fixed prompts across nine kinds, stable ids, deterministic", () => {
  const items = divergenceItems();
  assert.equal(items.length, 120);
  const kinds = {};
  for (const it of items) kinds[it.kind] = (kinds[it.kind] || 0) + 1;
  assert.deepEqual(kinds, { prose: 20, code: 20, maths: 20, follow: 10, json: 15, tool: 10, multi: 10, turns: 10, long: 5 });
  assert.equal(new Set(items.map((it) => it.id)).size, 120);
  assert.ok(items.every((it) => it.category === "divergence" && it.thinking === false && it.maxTokens >= 192));
  assert.equal(items.find((it) => it.kind === "long").maxTokens, 2048);
  assert.equal(items.find((it) => it.kind === "turns").messages.length, 3);
  assert.deepEqual(divergenceItems().map((it) => it.prompt), items.map((it) => it.prompt));
});

test("checkJson: validity, schema, fences", () => {
  const schema = { name: "string", age: "integer", tags: "array:2", active: "boolean" };
  assert.deepEqual(checkJson('{"name":"Ada","age":36,"tags":["a","b"],"active":true}', schema), { valid: true, schema: true, fenced: false, missing: [] });
  const fenced = checkJson('```json\n{"name":"Ada","age":36,"tags":["a","b"],"active":true}\n```', schema);
  assert.equal(fenced.schema, true);
  assert.equal(fenced.fenced, true);
  const wrong = checkJson('{"name":"Ada","age":"36","tags":["a"],"active":"yes"}', schema);
  assert.equal(wrong.valid, true);
  assert.equal(wrong.schema, false);
  assert.deepEqual(wrong.missing, ["age", "tags", "active"]);
  assert.equal(checkJson("Sure! Here is the JSON: {", schema).valid, false);
  assert.equal(checkJson("[1,2]", schema).valid, false);
});

test("checkToolCall: name, arguments (string or object), case-insensitive strings, numbers", () => {
  const want = { city: "Paris", unit: "celsius" };
  const good = checkToolCall([{ function: { name: "get_weather", arguments: '{"city":"paris","unit":"Celsius"}' } }], "get_weather", want);
  assert.deepEqual(good, { called: true, nameOk: true, argsOk: true, name: "get_weather", wrong: [] });
  const wrongName = checkToolCall([{ function: { name: "search_flights", arguments: "{}" } }], "get_weather", want);
  assert.equal(wrongName.nameOk, false);
  const wrongArgs = checkToolCall([{ function: { name: "get_weather", arguments: { city: "Lyon" } } }], "get_weather", want);
  assert.equal(wrongArgs.argsOk, false);
  assert.deepEqual(wrongArgs.wrong, ["city", "unit"]);
  assert.equal(checkToolCall([], "get_weather", want).called, false);
  assert.equal(checkToolCall([{ function: { name: "convert_currency", arguments: '{"amount":"250","from":"EUR","to":"JPY"}' } }], "convert_currency", { amount: 250, from: "EUR", to: "JPY" }).argsOk, true);
});

test("runDivergenceItem: non-streamed request, structural checks, loop detection, thinking-400 fallback", async () => {
  const items = divergenceItems();
  const prose = items.find((it) => it.kind === "prose");
  const bodies = [];
  const good = await runDivergenceItem({
    baseUrl: "http://x", modelId: "m", item: prose,
    fetchImpl: async (url, init) => {
      bodies.push(JSON.parse(init.body));
      return chat("The river kept its own counsel, and the village learned to listen.", {}, { prompt_tokens: 90, completion_tokens: 14, completion_tokens_details: { reasoning_tokens: 0 } });
    },
  });
  assert.equal(bodies[0].stream, false);
  assert.equal(bodies[0].temperature, 0);
  assert.equal(bodies[0].chat_template_kwargs.enable_thinking, false);
  assert.equal(good.ok, true);
  assert.equal(good.terminated, true);
  assert.equal(good.loop.loop, false);
  assert.equal(good.chars, 66);
  assert.equal(good.reply.length, 66);
  assert.equal(good.reasoningTokens, 0);
  assert.equal(good.hash.length, 16);

  const looping = await runDivergenceItem({ baseUrl: "http://x", modelId: "m", item: prose, fetchImpl: async () => chat(`Once upon a time ${"the river ran and ran, ".repeat(40)}`, { finish_reason: "length" }) });
  assert.equal(looping.ok, false);
  assert.equal(looping.terminated, false);
  assert.equal(looping.loop.loop, true);
  assert.ok(looping.loop.cycle >= 1 && looping.loop.cycle <= 10);
  assert.match(looping.detail, /loop: \d+-word cycle/);

  const jsonItem = items.find((it) => it.kind === "json");
  const j = await runDivergenceItem({ baseUrl: "http://x", modelId: "m", item: jsonItem, fetchImpl: async () => chat(`{"name":"Mo","age":40,"tags":${JSON.stringify(Array.from({ length: Number(jsonItem.schema.tags.slice(6)) }, (_, i) => `t${i}`))},"active":false}`) });
  assert.equal(j.ok, true);
  assert.equal(j.json.schema, true);

  const toolItem = items.find((it) => it.kind === "tool");
  const t = await runDivergenceItem({
    baseUrl: "http://x", modelId: "m", item: toolItem,
    fetchImpl: async (url, init) => {
      assert.ok(Array.isArray(JSON.parse(init.body).tools));
      return chat(null, { tool_calls: [{ id: "c1", type: "function", function: { name: "get_weather", arguments: '{"city":"Paris","unit":"celsius"}' } }], finish_reason: "tool_calls" });
    },
  });
  assert.equal(t.ok, true);
  assert.equal(t.terminated, true);
  assert.equal(t.toolCalls[0].name, "get_weather");
  assert.match(t.excerpt, /tool call get_weather/);

  // A server that refuses the thinking flags gets the fallback body once.
  let calls = 0;
  const fb = await runDivergenceItem({
    baseUrl: "http://x", modelId: "m", item: prose,
    fetchImpl: async (url, init) => {
      calls += 1;
      const b = JSON.parse(init.body);
      if (calls === 1) return jsonResponse(400, { error: { message: "unknown chat_template_kwargs key thinking_mode" } });
      assert.equal(b.enable_thinking, false);
      return chat("fine");
    },
  });
  assert.equal(calls, 2);
  assert.equal(fb.ok, true);

  const down = await runDivergenceItem({ baseUrl: "http://x", modelId: "m", item: prose, fetchImpl: async () => jsonResponse(500, { error: { message: "boom" } }) });
  assert.match(down.error, /HTTP 500: boom/);

  // summarize: structural rates, no pass rate, out of the overall
  const s = summarize([good, looping, j, t, down]);
  assert.equal(s.overallPct, null);
  const d = s.categories.divergence;
  assert.equal(d.pct, null);
  assert.equal(d.errors, 1);
  assert.equal(d.divergence.rows, 4);
  assert.equal(d.divergence.loops, 1);
  assert.equal(d.divergence.loopPct, 25);
  assert.equal(d.divergence.terminatedPct, 75);
  assert.equal(d.divergence.jsonValidPct, 100);
  assert.equal(d.divergence.toolOkPct, 100);
});
