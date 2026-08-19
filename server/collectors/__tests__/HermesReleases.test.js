import test from "node:test";
import assert from "node:assert/strict";
import {
  compareSemver,
  parsePendingCommits,
  parseRelease,
} from "../HermesReleases.js";

test("parseRelease maps and sanitizes a GitHub release payload", () => {
  const release = parseRelease({
    tag_name: "v2026.7.7.2",
    name: "Hermes Agent v0.18.1 (v2026.7.7.2)",
    published_at: "2026-07-08T00:00:00Z",
    html_url: "https://github.com/NousResearch/hermes-agent/releases/tag/v2026.7.7.2",
    body: "## What's Changed\n\n* Updated things\n",
  });
  assert.equal(release.tagName, "v2026.7.7.2");
  assert.equal(release.name, "Hermes Agent v0.18.1 (v2026.7.7.2)");
  assert.equal(release.semver, "0.18.1");
  assert.equal(release.version, "2026.7.7.2");
  assert.equal(release.publishedAt, "2026-07-08T00:00:00Z");
  assert.equal(release.htmlUrl, "https://github.com/NousResearch/hermes-agent/releases/tag/v2026.7.7.2");
  assert.equal(release.body, "## What's Changed\n\n* Updated things\n");
});

test("parseRelease extracts semver for bump detection", () => {
  // Name is preferred (carries the hermes v0.x.y version); the tag fallback
  // yields a date-style "semver" which is fine for a safe comparison.
  assert.equal(
    parseRelease({ tag_name: "v2026.8.3", name: "Hermes Agent v0.20.0 (2026.8.3)" })?.semver,
    "0.20.0"
  );
  assert.equal(parseRelease({ tag_name: "v1.0.0" })?.semver, "1.0.0");
  assert.equal(parseRelease({})?.semver, null);
});

test("compareSemver orders dotted versions", () => {
  assert.equal(compareSemver("0.19.1", "0.20.0"), -1);
  assert.equal(compareSemver("0.20.0", "0.20.0"), 0);
  assert.equal(compareSemver("0.20.1", "0.20.0"), 1);
  assert.equal(compareSemver("1.0.0", "0.99.99"), 1);
  assert.equal(compareSemver("0.20", "0.20.0"), 0);
  assert.equal(compareSemver("garbage", "0.1.0"), -1);
});

test("parsePendingCommits extracts commit lines and counters", () => {
  const out = [
    "__COMMITS__",
    "abc123\tfix(gpu): restore panel",
    "def456\tfeat(net): add link speed",
    "junk-line-without-tab",
    "__COUNT__",
    "2",
    "__HEAD__",
    "a726a4ae",
  ].join("\n");
  const parsed = parsePendingCommits(out);
  assert.equal(parsed.count, 2);
  assert.equal(parsed.headSha, "a726a4ae");
  assert.deepEqual(parsed.commits, [
    { sha: "abc123", title: "fix(gpu): restore panel" },
    { sha: "def456", title: "feat(net): add link speed" },
  ]);
});

test("parsePendingCommits returns null on empty input", () => {
  assert.equal(parsePendingCommits(""), null);
  assert.equal(parsePendingCommits(undefined), null);
});
