/**
 * The self-update check compares the running version with upstream `main`'s
 * package.json and pulls the matching notes from its CHANGELOG.md. These tests
 * pin the decisions that matter: the manifest is the source of truth, the
 * notes are optional, a failed check is silent and backs off, a successful
 * answer is reused for the TTL, and SPARKDASH_UPDATE_CHECK=off never goes out.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  compareVersions,
  createUpdateChecker,
  extractChangelogNotes,
  parseManifestVersion,
  updateChecksDisabled,
} from "../updateCheck.js";

const CHANGELOG_URL = "https://example.test/CHANGELOG.md";

const manifestResponse = (version) =>
  new Response(JSON.stringify({ name: "sparkdash", version }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
const textResponse = (body) => new Response(body, { status: 200 });

/** Fetch stub that answers the manifest and the changelog by URL. */
function stubUpstream({ version = "2.76.0", changelog = "## [Unreleased]\n- Pending change\n", manifestError = null, changelogError = null } = {}) {
  const calls = { manifest: 0, changelog: 0 };
  const fetchImpl = async (url) => {
    if (String(url).endsWith("CHANGELOG.md")) {
      calls.changelog += 1;
      if (changelogError) throw changelogError;
      return textResponse(changelog);
    }
    calls.manifest += 1;
    if (manifestError) throw manifestError;
    return manifestResponse(version);
  };
  return { fetchImpl, calls };
}

function clock(start = 1_000_000) {
  let at = start;
  return { now: () => at, advance: (ms) => { at += ms; } };
}

test("manifest versions are plain dotted numbers", () => {
  assert.equal(parseManifestVersion({ version: "2.75.4" }), "2.75.4");
  assert.equal(parseManifestVersion({ version: " 2.75.4 " }), "2.75.4");
  assert.equal(parseManifestVersion({ version: "2.76" }), "2.76");
  assert.equal(parseManifestVersion({ version: "2.75.4-rc.1" }), null);
  assert.equal(parseManifestVersion({ version: 275 }), null);
  assert.equal(parseManifestVersion({}), null);
  assert.equal(parseManifestVersion(null), null);
});

test("versions compare numerically, not lexically", () => {
  assert.equal(compareVersions("2.75.4", "2.75.4"), 0);
  assert.equal(compareVersions("2.75.10", "2.75.9"), 1);
  assert.equal(compareVersions("2.76.0", "2.75.99"), 1);
  assert.equal(compareVersions("2.75", "2.75.0"), 0);
  assert.equal(compareVersions("3.0.0", "10.0.0"), -1);
});

test("SPARKDASH_UPDATE_CHECK=off disables the check, other values do not", () => {
  for (const off of ["off", "OFF", "0", "false", "no", "disabled", " off "]) {
    assert.equal(updateChecksDisabled(off), true, off);
  }
  // `undefined` reads the ambient environment, so pin it around the assertion.
  const saved = process.env.SPARKDASH_UPDATE_CHECK;
  delete process.env.SPARKDASH_UPDATE_CHECK;
  try {
    assert.equal(updateChecksDisabled(undefined), false, "unset");
  } finally {
    if (saved === undefined) delete process.env.SPARKDASH_UPDATE_CHECK;
    else process.env.SPARKDASH_UPDATE_CHECK = saved;
  }
  for (const on of ["", "1", "on", "true"]) {
    assert.equal(updateChecksDisabled(on), false, String(on));
  }
});

test("a newer upstream version is reported once and then cached for the TTL", async () => {
  const time = clock();
  const { fetchImpl, calls } = stubUpstream();
  const checker = createUpdateChecker({
    enabled: true,
    currentVersion: "2.75.4",
    changelogUrl: CHANGELOG_URL,
    now: time.now,
    ttlMs: 60_000,
    fetchImpl,
  });

  const first = await checker.status();
  assert.deepEqual(first, {
    enabled: true,
    currentVersion: "2.75.4",
    latestVersion: "2.76.0",
    updateAvailable: true,
    notes: "## Unreleased\n- Pending change",
    checkedAt: 1_000_000,
  });

  time.advance(59_999);
  const cached = await checker.status();
  assert.equal(cached.updateAvailable, true);
  assert.equal(calls.manifest, 1);
  assert.equal(calls.changelog, 1);

  time.advance(1);
  await checker.status();
  assert.equal(calls.manifest, 2);
});

test("equal or older upstream versions are not an update", async () => {
  for (const latest of ["2.75.4", "2.75.3"]) {
    const { fetchImpl } = stubUpstream({ version: latest });
    const checker = createUpdateChecker({
      enabled: true,
      currentVersion: "2.75.4",
      changelogUrl: CHANGELOG_URL,
      fetchImpl,
    });
    const status = await checker.status();
    assert.equal(status.updateAvailable, false, latest);
  }
});

test("an unreachable manifest stays unknown, backs off, and recovers", async () => {
  const time = clock();
  let fail = true;
  let manifestCalls = 0;
  const checker = createUpdateChecker({
    enabled: true,
    currentVersion: "2.75.4",
    changelogUrl: CHANGELOG_URL,
    now: time.now,
    ttlMs: 60_000,
    retryBaseMs: 1_000,
    fetchImpl: async (url) => {
      if (String(url).endsWith("CHANGELOG.md")) return textResponse("## [Unreleased]\n- Pending\n");
      manifestCalls += 1;
      if (fail) throw new Error("offline");
      return manifestResponse("2.76.0");
    },
  });

  const offline = await checker.status();
  assert.equal(offline.latestVersion, null);
  assert.equal(offline.updateAvailable, null);
  assert.equal(offline.notes, null);
  assert.equal(offline.checkedAt, null);

  // Still inside the 1 s ±20% backoff: no second request on the next page load.
  await checker.status();
  assert.equal(manifestCalls, 1);

  time.advance(2_000);
  fail = false;
  const recovered = await checker.status();
  assert.equal(manifestCalls, 2);
  assert.equal(recovered.latestVersion, "2.76.0");
  assert.equal(recovered.updateAvailable, true);
  assert.equal(recovered.notes, "## Unreleased\n- Pending");
});

test("a malformed manifest is a failed check, not a crash", async () => {
  const checker = createUpdateChecker({
    enabled: true,
    currentVersion: "2.75.4",
    changelogUrl: CHANGELOG_URL,
    fetchImpl: async (url) =>
      String(url).endsWith("CHANGELOG.md") ? textResponse("## [Unreleased]\n- x\n") : new Response("not json", { status: 200 }),
  });
  const status = await checker.status();
  assert.equal(status.latestVersion, null);
  assert.equal(status.updateAvailable, null);
  assert.equal(status.notes, null);
});

test("a failed refresh keeps the last good answer", async () => {
  const time = clock();
  let fail = false;
  const checker = createUpdateChecker({
    enabled: true,
    currentVersion: "2.75.4",
    changelogUrl: CHANGELOG_URL,
    now: time.now,
    ttlMs: 60_000,
    fetchImpl: async (url) => {
      if (String(url).endsWith("CHANGELOG.md")) return textResponse("## [Unreleased]\n- Pending\n");
      if (fail) throw new Error("offline");
      return manifestResponse("2.76.0");
    },
  });

  const good = await checker.status();
  assert.equal(good.updateAvailable, true);
  fail = true;
  time.advance(61_000);
  const stale = await checker.status();
  assert.equal(stale.latestVersion, "2.76.0");
  assert.equal(stale.updateAvailable, true);
  assert.equal(stale.notes, good.notes);
  assert.equal(stale.checkedAt, good.checkedAt);
});

test("a failed changelog still reports the newer version", async () => {
  const { fetchImpl } = stubUpstream({ changelogError: new Error("no changelog") });
  const checker = createUpdateChecker({
    enabled: true,
    currentVersion: "2.75.4",
    changelogUrl: CHANGELOG_URL,
    fetchImpl,
  });
  const status = await checker.status();
  assert.equal(status.updateAvailable, true);
  assert.equal(status.latestVersion, "2.76.0");
  assert.equal(status.notes, null);
});

test("concurrent status calls share one fetch", async () => {
  let manifests = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const checker = createUpdateChecker({
    enabled: true,
    currentVersion: "2.75.4",
    changelogUrl: CHANGELOG_URL,
    fetchImpl: async (url) => {
      if (String(url).endsWith("CHANGELOG.md")) return textResponse("## [Unreleased]\n- Pending\n");
      manifests += 1;
      await gate;
      return manifestResponse("2.76.0");
    },
  });

  const first = checker.status();
  const second = checker.status();
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(manifests, 1);
  assert.equal(a.updateAvailable, true);
  assert.equal(b.updateAvailable, true);
});

test("the opt-out never fetches and reports itself disabled", async () => {
  let calls = 0;
  const checker = createUpdateChecker({
    currentVersion: "2.75.4",
    enabled: false,
    fetchImpl: async () => {
      calls += 1;
      return manifestResponse("2.76.0");
    },
  });
  const status = await checker.status();
  assert.equal(calls, 0);
  assert.deepEqual(status, {
    enabled: false,
    currentVersion: "2.75.4",
    latestVersion: null,
    updateAvailable: null,
    notes: null,
    checkedAt: null,
  });
});

test("an unreadable running version stays unknown instead of guessing", async () => {
  const { fetchImpl } = stubUpstream();
  const checker = createUpdateChecker({
    enabled: true,
    currentVersion: null,
    changelogUrl: CHANGELOG_URL,
    fetchImpl,
  });
  const status = await checker.status();
  assert.equal(status.currentVersion, null);
  assert.equal(status.latestVersion, "2.76.0");
  assert.equal(status.updateAvailable, null);
});

test("changelog notes cover the unreleased section and versions newer than the running one", () => {
  const markdown = [
    "# Changelog",
    "",
    "## [Unreleased]",
    "",
    "### Added",
    "- new thing",
    "",
    "## [2.70.0] — 2026-10-22",
    "",
    "- released change",
    "",
    "## [2.50.0] — 2026-10-15",
    "",
    "- older change",
  ].join("\n");

  assert.equal(
    extractChangelogNotes(markdown, "2.40.0"),
    [
      "## Unreleased",
      "",
      "### Added",
      "- new thing",
      "",
      "## 2.70.0 — 2026-10-22",
      "",
      "- released change",
      "",
      "## 2.50.0 — 2026-10-15",
      "",
      "- older change",
    ].join("\n"),
  );
  // Sections at or below the running version are already in this install.
  assert.equal(
    extractChangelogNotes(markdown, "2.70.0"),
    "## Unreleased\n\n### Added\n- new thing",
  );
  assert.equal(extractChangelogNotes("No headings", "2.75.0"), null);
  assert.equal(extractChangelogNotes(null, "2.75.0"), null);
  assert.equal(
    extractChangelogNotes("## [Unreleased]\n" + "x".repeat(100), "2.75.0", 20).length,
    20,
  );
});
