/**
 * HermesReleases — release + pending-commit helpers for the Hermes update
 * confirmation dialog.
 *
 * Hermes updates from `origin/main` (git), not from tagged GitHub releases. A
 * spark is often "N commits behind main" without any new tagged release, so the
 * dialog must show what would actually change: the pending commits. The latest
 * GitHub release is still fetched (cached) so we can detect a real version bump
 * and show the release changelog only in that case.
 */
const GITHUB_API_URL =
  "https://api.github.com/repos/NousResearch/hermes-agent/releases/latest";
const FETCH_TIMEOUT_MS = 8000;
const RELEASES_CACHE_MS = parseInt(
  process.env.HERMES_RELEASES_CACHE_MS || "1800000",
  10
);

let cache = { at: 0, release: null };

/**
 * Pure mapper over the GitHub release payload shape (exported for tests).
 * Accepts only strings — never throws on a malformed payload.
 * @param {unknown} data
 */
export function parseRelease(data) {
  if (!data || typeof data !== "object") return null;
  const tagName = typeof data.tag_name === "string" ? data.tag_name : "";
  const name = typeof data.name === "string" ? data.name : tagName;
  // Semantic version (e.g. "0.20.0") extracted from the release name/tag so the
  // dialog can tell "update to the same version's later commits" apart from a
  // real release bump (hermes versions are v0.x.y, tags are date-formatted).
  const m = /\bv?(\d+\.\d+(?:\.\d+)*)/.exec(name || tagName);
  return {
    tagName,
    name,
    version: tagName.replace(/^v/i, ""),
    semver: m ? m[1].replace(/^v/i, "") : null,
    publishedAt: typeof data.published_at === "string" ? data.published_at : null,
    htmlUrl:
      typeof data.html_url === "string"
        ? data.html_url
        : `https://github.com/NousResearch/hermes-agent/releases/tag/${tagName}`,
    body: typeof data.body === "string" ? data.body : "",
  };
}

/**
 * Compare two dotted-numeric versions ("1.2.3"). Returns <0 / 0 / >0.
 * Unparseable segments are treated as 0. Never throws.
 * @param {string} a
 * @param {string} b
 */
export function compareSemver(a, b) {
  const pa = String(a || "").split(".");
  const pb = String(b || "").split(".");
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const va = parseInt(pa[i], 10);
    const vb = parseInt(pb[i], 10);
    const na = Number.isInteger(va) ? va : 0;
    const nb = Number.isInteger(vb) ? vb : 0;
    if (na !== nb) return na < nb ? -1 : 1;
  }
  return 0;
}

/**
 * Parse the output of the pending-commits git probe into a structured result.
 * Lines between the __COMMITS__/__COUNT__/__HEAD__ markers are `sha<TAB>subject`.
 * @param {string} output
 */
export function parsePendingCommits(output) {
  if (typeof output !== "string" || !output) return null;
  const section = (marker) => {
    const parts = output.split(marker);
    if (parts.length < 2) return "";
    // Skip the marker's own trailing newline before taking the first line.
    const first = parts[1].replace(/^\n/, "").split(/\n/)[0] || "";
    return first.trim();
  };
  const commitBlock = output.split("__COMMITS__")[1]?.split("__COUNT__")[0] || "";
  const commits = [];
  for (const line of commitBlock.split("\n")) {
    const tab = line.indexOf("\t");
    if (tab > 0) {
      const sha = line.slice(0, tab).trim();
      const title = line.slice(tab + 1).trim();
      if (sha && title) commits.push({ sha, title });
    }
  }
  const countRaw = section("__COUNT__");
  const count = Number.isInteger(parseInt(countRaw, 10)) ? parseInt(countRaw, 10) : null;
  return {
    count: count !== null ? count : commits.length,
    headSha: section("__HEAD__") || null,
    commits: commits.slice(0, 30),
  };
}

/**
 * Latest release (cached). Throws with a descriptive message on network /
 * API failures so the route can surface them (the dialog still allows updating
 * without the changelog).
 * @returns {Promise<object>}
 */
export async function getLatestRelease() {
  if (cache.release && Date.now() - cache.at < RELEASES_CACHE_MS) {
    return cache.release;
  }
  const res = await fetch(GITHUB_API_URL, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "sparkdash",
    },
  });
  if (!res.ok) throw new Error(`GitHub API returned HTTP ${res.status}`);
  const release = parseRelease(await res.json());
  cache = { at: Date.now(), release };
  return release;
}
