/**
 * Channel payload shapes (ntfy / Discord / Slack / webhook), severity
 * filtering, and failures that never throw.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { Notifier, buildRequest, filterGroupForChannel } from "../notifier.js";
import { clock, stubFetch } from "./fixtures.js";

const T0 = Date.UTC(2026, 9, 6, 12, 0, 0);

function alert(over = {}) {
  return {
    key: "memory_headroom:spark-1",
    ruleId: "memory_headroom",
    ruleName: "Memory headroom",
    unitId: "spark-1",
    unitName: "spark-1",
    severity: "warning",
    peakSeverity: "warning",
    summary: "7.2 GB unified memory free (low < 8.0 GB)",
    value: 7373,
    startsAt: T0 - 180_000,
    endsAt: null,
    ...over,
  };
}

const group = {
  firing: [alert(), alert({ key: "unit_offline:rtx", ruleId: "unit_offline", ruleName: "Unit offline", unitId: "rtx", unitName: "RTX PRO 6000", severity: "critical", peakSeverity: "critical", summary: "Unreachable", value: null })],
  resolved: [alert({ key: "disk_usage:spark-2:/dev/a", ruleId: "disk_usage", ruleName: "Disk usage", unitId: "spark-2", unitName: "spark-2", summary: "/ 91% full", endsAt: T0 - 1000 })],
};

test("ntfy: plain text body with Title / Priority / Tags headers", () => {
  const { url, init } = buildRequest({ type: "ntfy", url: "https://ntfy.example/topic" }, group, T0);
  assert.equal(url, "https://ntfy.example/topic");
  assert.equal(init.method, "POST");
  assert.equal(init.headers.Title, "sparkDash: 2 firing, 1 resolved");
  assert.equal(init.headers.Priority, "5", "a critical alert in the group → max priority");
  assert.equal(init.headers.Tags, "rotating_light");
  assert.match(init.body, /^WARNING spark-1 · Memory headroom: 7\.2 GB unified memory free \(low < 8\.0 GB\) \(for 3m\)$/m);
  assert.match(init.body, /^CRITICAL RTX PRO 6000 · Unit offline: Unreachable/m);
  assert.match(init.body, /^RESOLVED spark-2 · Disk usage/m);

  const single = buildRequest({ type: "ntfy", url: "https://n/t" }, { firing: [alert({ unitName: "spärk-1" })], resolved: [] }, T0);
  assert.match(single.init.headers.Title, /^=\?UTF-8\?B\?/, "non-ASCII titles are RFC 2047 encoded");
  assert.equal(Buffer.from(single.init.headers.Title.slice(10, -2), "base64").toString(), "[WARNING] spärk-1: Memory headroom");
  assert.equal(single.init.headers.Priority, "4");
  const resolvedOnly = buildRequest({ type: "ntfy", url: "https://n/t" }, { firing: [], resolved: [group.resolved[0]] }, T0);
  assert.equal(resolvedOnly.init.headers.Tags, "white_check_mark");
  assert.equal(resolvedOnly.init.headers.Priority, "3");
});

test("discord: JSON content + one embed per alert, mentions disabled", () => {
  const { init } = buildRequest({ type: "discord", url: "https://discord.com/api/webhooks/1/x" }, group, T0);
  assert.equal(init.headers["Content-Type"], "application/json");
  const body = JSON.parse(init.body);
  assert.equal(body.content, "sparkDash: 2 firing, 1 resolved");
  assert.equal(body.embeds.length, 3);
  assert.equal(body.embeds[0].title, "Warning · spark-1: Memory headroom");
  assert.equal(body.embeds[1].color, 0xdc2626);
  assert.equal(body.embeds[2].title, "Resolved · spark-2: Disk usage");
  assert.deepEqual(body.allowed_mentions, { parse: [] });

  const many = { firing: Array.from({ length: 13 }, (_, i) => alert({ key: `k${i}` })), resolved: [] };
  const big = JSON.parse(buildRequest({ type: "discord", url: "https://d/x" }, many, T0).init.body);
  assert.equal(big.embeds.length, 10, "Discord's 10-embed limit");
  assert.match(big.content, /\+3 more/);
});

test("slack: JSON { text } with one bullet per alert", () => {
  const body = JSON.parse(buildRequest({ type: "slack", url: "https://hooks.slack.com/services/x" }, group, T0).init.body);
  assert.deepEqual(Object.keys(body), ["text"]);
  assert.match(body.text, /^\*sparkDash: 2 firing, 1 resolved\*\n• WARNING spark-1/);
  assert.equal(body.text.split("\n").length, 4);
});

test("webhook: generic JSON with status, severity, rule, unit, summary, startsAt, endsAt, value", () => {
  const body = JSON.parse(buildRequest({ type: "webhook", url: "http://127.0.0.1:5699/hook" }, group, T0).init.body);
  assert.equal(body.source, "sparkDash");
  assert.equal(body.status, "firing");
  assert.equal(body.severity, "critical");
  assert.equal(body.alerts.length, 3);
  assert.deepEqual(body.alerts[0], {
    status: "firing",
    severity: "warning",
    rule: "memory_headroom",
    ruleName: "Memory headroom",
    unit: "spark-1",
    unitId: "spark-1",
    summary: "7.2 GB unified memory free (low < 8.0 GB)",
    startsAt: new Date(T0 - 180_000).toISOString(),
    endsAt: null,
    value: 7373,
  });
  assert.equal(body.alerts[2].status, "resolved");
  assert.equal(body.alerts[2].endsAt, new Date(T0 - 1000).toISOString());
  const test = JSON.parse(buildRequest({ type: "webhook", url: "http://h/" }, { test: true, firing: [], resolved: [] }, T0).init.body);
  assert.equal(test.status, "test");
  assert.equal(test.title, "sparkDash test notification");
});

test("channel min severity filters firing alerts; resolved go where they fired", () => {
  const critOnly = filterGroupForChannel({ minSeverity: "critical" }, group);
  assert.deepEqual(critOnly.firing.map((a) => a.unitName), ["RTX PRO 6000"]);
  assert.equal(critOnly.resolved.length, 0);
  assert.equal(filterGroupForChannel({ minSeverity: "critical" }, { firing: [alert()], resolved: [] }), null);
  const escalatedThenResolved = { firing: [], resolved: [alert({ severity: "warning", peakSeverity: "critical" })] };
  assert.equal(filterGroupForChannel({ minSeverity: "critical" }, escalatedThenResolved).resolved.length, 1);
});

test("dispatch sends one request per enabled channel and records success", async () => {
  const fetch = stubFetch(200);
  const n = new Notifier({ fetchImpl: fetch, now: clock(T0) });
  const results = await n.dispatch(
    [
      { id: "a", name: "A", type: "webhook", url: "http://127.0.0.1/a", enabled: true, minSeverity: "warning" },
      { id: "b", name: "B", type: "slack", url: "http://127.0.0.1/b", enabled: false, minSeverity: "warning" },
      { id: "c", name: "C", type: "ntfy", url: "http://127.0.0.1/c", enabled: true, minSeverity: "critical" },
    ],
    group
  );
  assert.equal(fetch.calls.length, 2);
  assert.deepEqual(results.map((r) => [r.channelId, r.ok]), [["a", true], ["c", true]]);
  assert.equal(n.status.get("a").lastSentAt, T0);
  assert.ok(fetch.calls[0].init.signal instanceof AbortSignal, "every request carries a timeout signal");
});

test("failures never throw, are recorded, and are logged at most once per interval", async () => {
  const warnings = [];
  const now = clock(T0);
  const ch = { id: "x", name: "Dead", type: "webhook", url: "http://127.0.0.1:1/", enabled: true, minSeverity: "warning" };

  const http500 = new Notifier({ fetchImpl: stubFetch(500, { body: "nope" }), now, log: { warn: (m) => warnings.push(m) } });
  const r = await http500.send(ch, group);
  assert.deepEqual(r, { ok: false, error: "HTTP 500: nope" });
  assert.equal(http500.status.get("x").lastError, "HTTP 500: nope");

  const refused = Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
  const down = new Notifier({ fetchImpl: stubFetch(200, { throws: refused }), now, log: { warn: (m) => warnings.push(m) } });
  for (let i = 0; i < 5; i++) {
    const res = await down.send(ch, group);
    assert.equal(res.ok, false);
    assert.equal(res.error, "fetch failed (ECONNREFUSED)");
  }
  assert.equal(warnings.length, 2, "one line per notifier, not one per failure");
  now.advance(5 * 60_000);
  await down.send(ch, group);
  assert.equal(warnings.length, 3);
  assert.match(warnings[2], /4 more failures/);

  const timeout = Object.assign(new Error("aborted"), { name: "TimeoutError" });
  const slow = new Notifier({ fetchImpl: stubFetch(200, { throws: timeout }), now, timeoutMs: 10_000, log: { warn() {} } });
  assert.equal((await slow.send(ch, group)).error, "timed out after 10s");

  const throwsSync = new Notifier({ fetchImpl: () => { throw new Error("sync boom"); }, now, log: { warn() {} } });
  assert.equal((await throwsSync.send(ch, group)).ok, false);
});
