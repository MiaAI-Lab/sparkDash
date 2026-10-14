/**
 * Notifier: message formats, and the three things the review asked for —
 * the outbound policy applied on every send (pinned to the checked address),
 * redirects never followed, and no response body anywhere.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { Notifier, buildRequest, describeGroup, filterGroupForChannel, slackEscape } from "../notifier.js";
import { POLICY_BLOCKED, POLICY_UNRESOLVED } from "../outbound.js";
import { LEAK, quietLog, receiver, stubFetch, stubLookup } from "./fixtures.js";

const NOW = 1_800_000_000_000;
const alert = (over = {}) => ({
  key: "spark-1:thermal",
  ruleId: "thermal",
  ruleName: "GPU temperature",
  unitId: "spark-1",
  unitName: "spark-1",
  severity: "critical",
  peakSeverity: "critical",
  label: "GPU is close to its shutdown temperature",
  summary: "91°C (warns at 85°C, critical at 90°C).",
  startsAt: NOW - 5 * 60_000,
  ...over,
});
const firing = { firing: [alert()], resolved: [], reminder: false };

test("ntfy: title, priority and tags from the group; one line per alert", () => {
  const { url, init } = buildRequest({ type: "ntfy", url: "https://ntfy.example.com/t" }, firing, NOW);
  assert.equal(url, "https://ntfy.example.com/t");
  assert.equal(init.headers.Title, "[CRITICAL] spark-1: GPU is close to its shutdown temperature");
  assert.equal(init.headers.Priority, "5");
  assert.match(init.body, /CRITICAL spark-1 · GPU temperature: 91°C .* \(for 5m\)/);
});

test("discord never pings and caps embed text; slack and webhook carry the same alerts", () => {
  const d = JSON.parse(buildRequest({ type: "discord", url: "https://d/x" }, firing, NOW).init.body);
  assert.deepEqual(d.allowed_mentions, { parse: [] });
  assert.equal(d.embeds.length, 1);
  const s = JSON.parse(buildRequest({ type: "slack", url: "https://s/x" }, firing, NOW).init.body);
  assert.match(s.text, /GPU temperature/);
  const w = JSON.parse(buildRequest({ type: "webhook", url: "https://w/x" }, firing, NOW).init.body);
  assert.equal(w.status, "firing");
  assert.equal(w.alerts[0].rule, "thermal");
  assert.equal(w.alerts[0].label, "GPU is close to its shutdown temperature");
});

test("slack text escapes &, < and > so unit names and remote text cannot mention or link", () => {
  const hostile = {
    firing: [alert({ unitName: "<!channel> & <https://evil.example|click>", summary: "Xid 79 <!here> <@U123>" })],
    resolved: [],
  };
  const { text } = JSON.parse(buildRequest({ type: "slack", url: "https://s/x" }, hostile, NOW).init.body);
  assert.ok(!/[<>]/.test(text), text);
  assert.match(text, /&lt;!channel&gt; &amp; &lt;https:\/\/evil\.example\|click&gt;/);
  assert.equal(slackEscape("a & b < c > d"), "a &amp; b &lt; c &gt; d");
});

test("a large group is cut to a fixed number of lines", () => {
  const many = { firing: Array.from({ length: 40 }, (_, i) => alert({ key: `u${i}:thermal`, unitName: `u${i}` })), resolved: [] };
  const d = describeGroup(many, NOW);
  assert.equal(d.lines.length, 21);
  assert.equal(d.lines.at(-1), "+20 more");
});

test("a channel's minimum severity filters the group; resolved follows the peak", () => {
  const ch = { minSeverity: "critical" };
  assert.equal(filterGroupForChannel(ch, { firing: [alert({ severity: "warning", peakSeverity: "warning" })], resolved: [] }), null);
  const r = filterGroupForChannel(ch, { firing: [], resolved: [alert({ severity: "warning", peakSeverity: "critical" })] });
  assert.equal(r.resolved.length, 1);
});

test("send: delivered through a real socket, pinned to the address the policy checked", async (t) => {
  const rx = await receiver();
  t.after(rx.close);
  const lookup = stubLookup(["127.0.0.1"]);
  const n = new Notifier({ lookup, log: quietLog });
  const r = await n.send({ id: "c", name: "Local", type: "webhook", url: `http://hooks.example.test:${rx.port}/hook` }, firing);
  assert.deepEqual(r, { ok: true, status: 200 });
  assert.equal(rx.requests.length, 1);
  assert.equal(rx.requests[0].url, "/hook");
  assert.equal(JSON.parse(rx.requests[0].body).alerts[0].unit, "spark-1");
  assert.deepEqual(lookup.asked, ["hooks.example.test"], "resolved exactly once — the connection reuses that answer");
});

test("send: a host that resolves to a forbidden address is refused, and nothing is sent", async (t) => {
  const rx = await receiver();
  t.after(rx.close);
  // DNS rebinding / changed records: the name now answers with the metadata address.
  const n = new Notifier({ lookup: stubLookup(["169.254.169.254"]), log: quietLog });
  const r = await n.send({ id: "c", name: "X", type: "webhook", url: `http://hooks.example.test:${rx.port}/hook` }, firing);
  assert.deepEqual(r, { ok: false, error: POLICY_BLOCKED });
  assert.equal(rx.requests.length, 0);
  assert.equal(n.status.get("c").lastError, POLICY_BLOCKED);
  assert.ok(!POLICY_BLOCKED.includes("169.254"), "the reason names no address");

  for (const bad of [["0.0.0.0"], ["::ffff:169.254.169.254"], ["fe80::1"], ["224.0.0.1"]]) {
    const r2 = await new Notifier({ lookup: stubLookup(bad), log: quietLog }).send({ id: "c", name: "X", type: "webhook", url: `http://h.example.test:${rx.port}/` }, firing);
    assert.equal(r2.error, POLICY_BLOCKED, bad[0]);
  }
  const literal = await new Notifier({ log: quietLog }).send({ id: "c", name: "X", type: "webhook", url: "http://169.254.169.254/latest" }, firing);
  assert.equal(literal.error, POLICY_BLOCKED);
  assert.equal(rx.requests.length, 0);
});

test("send: an unresolvable host fails with a fixed reason", async () => {
  const lookup = async () => {
    throw Object.assign(new Error("getaddrinfo ENOTFOUND secret-topic.example.test"), { code: "ENOTFOUND" });
  };
  const r = await new Notifier({ lookup, log: quietLog }).send({ id: "c", name: "X", type: "ntfy", url: "https://secret-topic.example.test/t" }, firing);
  assert.deepEqual(r, { ok: false, error: POLICY_UNRESOLVED });
});

test("send: a redirect is not followed and counts as a failure", async (t) => {
  const target = await receiver();
  t.after(target.close);
  const rx = await receiver((_req, res) => {
    res.writeHead(302, { Location: `http://127.0.0.1:${target.port}/elsewhere` });
    res.end(`moved: ${LEAK}`);
  });
  t.after(rx.close);
  const n = new Notifier({ log: quietLog });
  const r = await n.send({ id: "c", name: "R", type: "ntfy", url: `http://127.0.0.1:${rx.port}/topic` }, firing);
  assert.deepEqual(r, { ok: false, error: "redirect not followed (HTTP 302)" });
  assert.equal(target.requests.length, 0, "the redirect target never saw a request");
  for (const status of [301, 307, 308]) {
    const r2 = await new Notifier({ fetchImpl: stubFetch(status, { headers: { Location: "http://x/" } }), lookup: stubLookup(["10.0.0.5"]), log: quietLog }).send({ id: "c", name: "R", type: "ntfy", url: "http://ntfy.lan/t" }, firing);
    assert.equal(r2.error, `redirect not followed (HTTP ${status})`);
  }
});

test("send: no response body reaches the result, the status or the log", async (t) => {
  const rx = await receiver((_req, res) => {
    res.writeHead(500, { "content-type": "text/plain" });
    res.end(`internal error, token=${LEAK}`);
  });
  t.after(rx.close);
  const logged = [];
  const reported = [];
  const n = new Notifier({ log: { warn: (m) => logged.push(m) }, onResult: (x) => reported.push(x) });
  const r = await n.send({ id: "c", name: "B", type: "slack", url: `http://127.0.0.1:${rx.port}/x` }, firing);
  assert.deepEqual(r, { ok: false, error: "HTTP 500" });
  const everything = JSON.stringify({ r, status: [...n.status.values()], logged, reported: reported.map(({ ok, status, reason }) => ({ ok, status, reason })) });
  assert.ok(!everything.includes(LEAK), everything);
  assert.ok(!everything.includes("internal error"));

  const ok = await new Notifier({ fetchImpl: stubFetch(200, { body: `ok ${LEAK}` }), lookup: stubLookup(["10.0.0.5"]), log: quietLog }).send({ id: "c", name: "B", type: "slack", url: "http://hooks.lan/x" }, firing);
  assert.deepEqual(ok, { ok: true, status: 200 });
});

test("send: socket errors and timeouts become fixed reasons, never the error text", async () => {
  const boom = Object.assign(new TypeError(`fetch failed for http://user:${LEAK}@x/`), { cause: { code: "ECONNREFUSED", message: LEAK } });
  const r = await new Notifier({ fetchImpl: stubFetch(0, { throws: boom }), lookup: stubLookup(["10.0.0.5"]), log: quietLog }).send({ id: "c", name: "E", type: "webhook", url: "http://hooks.lan/x" }, firing);
  assert.deepEqual(r, { ok: false, error: "connection failed (ECONNREFUSED)" });
  const slow = Object.assign(new Error("aborted"), { name: "TimeoutError" });
  const r2 = await new Notifier({ fetchImpl: stubFetch(0, { throws: slow }), lookup: stubLookup(["10.0.0.5"]), timeoutMs: 10_000, log: quietLog }).send({ id: "c", name: "E", type: "webhook", url: "http://hooks.lan/x" }, firing);
  assert.equal(r2.error, "timed out after 10s");
  const weird = new Error(LEAK);
  const r3 = await new Notifier({ fetchImpl: stubFetch(0, { throws: weird }), lookup: stubLookup(["10.0.0.5"]), log: quietLog }).send({ id: "c", name: "E", type: "webhook", url: "http://hooks.lan/x" }, firing);
  assert.equal(r3.error, "request failed");
});

test("dispatch skips disabled channels and channels whose minimum the group does not meet", async () => {
  const fetchImpl = stubFetch(200);
  const n = new Notifier({ fetchImpl, lookup: stubLookup(["192.168.1.20"]), log: quietLog });
  const results = await n.dispatch(
    [
      { id: "a", name: "A", type: "ntfy", url: "http://ntfy.lan/a", enabled: true, minSeverity: "warning" },
      { id: "b", name: "B", type: "ntfy", url: "http://ntfy.lan/b", enabled: false, minSeverity: "warning" },
      { id: "c", name: "C", type: "ntfy", url: "http://ntfy.lan/c", enabled: true, minSeverity: "critical" },
    ],
    { firing: [alert({ severity: "warning", peakSeverity: "warning" })], resolved: [] }
  );
  assert.deepEqual(results.map((x) => x.channelId), ["a"]);
  assert.equal(fetchImpl.calls[0].init.redirect, "manual");
});
