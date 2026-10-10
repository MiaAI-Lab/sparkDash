import { test } from "node:test";
import { strict as assert } from "node:assert";
import { createLiveRate } from "../DecodeBench.js";

test("live rate comes from streamed tokens across streams, and is null-free until tokens arrive", () => {
  let t = 0;
  const seen = [];
  const live = createLiveRate(2, (v) => seen.push(v), { now: () => t, intervalMs: 1_000_000 });
  t = 1000;
  live.tick();
  assert.deepEqual(seen, []); // still prefilling: no reading, not 0
  live.note(0, 40);
  live.note(1, 60);
  t = 2000;
  live.tick();
  assert.equal(seen.at(-1), 100); // 100 tokens in the last second, all streams
  live.note(0, 90);
  live.note(1, 110);
  t = 3000;
  live.tick();
  assert.equal(seen.at(-1), 100); // (200-0) over the 2 s window... = 100/s
  // counters that never move past the window report a real zero once streaming has started
  t = 6000;
  live.tick();
  t = 7000;
  live.tick();
  assert.equal(seen.at(-1), 0);
  live.stop();
  assert.equal(seen.at(-1), null);
});

test("live rate ignores garbage counts and a throwing callback never breaks the run", () => {
  let t = 0;
  const live = createLiveRate(1, () => {
    throw new Error("display bug");
  }, { now: () => t, intervalMs: 1_000_000 });
  live.note(0, "abc");
  live.note(0, -5);
  t = 1000;
  assert.doesNotThrow(() => live.tick());
  assert.doesNotThrow(() => live.stop());
});

import http from "node:http";
import { runConcurrencyWave } from "../DecodeBench.js";

test("a wave reports a live rate while the engine publishes no live counters of its own", async (t) => {
  // An OpenAI-style streaming server: ~1 token every 15 ms for ~2.4 s, usage only at the end.
  const server = http.createServer((req, res) => {
    if (req.method !== "POST") return res.end();
    req.resume();
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    let i = 0;
    const timer = setInterval(() => {
      if (i >= 160) {
        res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 160 } })}\n\n`);
        res.write("data: [DONE]\n\n");
        clearInterval(timer);
        return res.end();
      }
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "tok " } }] })}\n\n`);
      i += 1;
    }, 15);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const live = [];
  const wave = await runConcurrencyWave({
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    modelId: "m",
    concurrency: 2,
    maxTokens: 160,
    onLive: (v) => live.push(v),
  });
  assert.equal(wave.streamsOk, 2);
  const readings = live.filter((v) => v != null);
  assert.ok(readings.length >= 1, `no live readings: ${JSON.stringify(live)}`);
  assert.ok(readings.some((v) => v > 20), `expected tokens/s well above 0, got ${JSON.stringify(readings)}`);
  assert.equal(live.at(-1), null); // cleared when the wave ends
});
