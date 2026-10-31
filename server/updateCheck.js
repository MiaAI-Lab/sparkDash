/**
 * Self-update check for sparkDash itself.
 *
 * sparkDash is deployed by the operator as a checkout (Docker or `npm start`),
 * so this process cannot replace its own code. The check only answers whether
 * upstream `main` advertises a newer version than the one this process runs;
 * the dashboard reports that answer and the operator applies the update.
 *
 * Upstream tags releases rarely but bumps `version` in `package.json` on
 * `main` constantly (the latest tag was v2.32.0 while main was 2.75.4), so the
 * manifest, not the GitHub releases API, is the source of truth. It is fetched
 * from raw.githubusercontent.com (no unauthenticated API rate limit) at most
 * once per TTL after a successful check; a failure is silent and retried with
 * capped exponential backoff from five minutes. The check is lazy: no timer
 * runs while nobody asks for the status.
 */

const DEFAULT_SOURCE_URL =
  "https://raw.githubusercontent.com/MiaAI-Lab/sparkDash/main/package.json";
/**
 * Upstream stopped adding per-version sections after 2.70.0; everything since
 * (including every 2.75.x bump) is under `[Unreleased]`. The top of this file
 * is the only human-written account of what a newer version contains.
 */
const DEFAULT_CHANGELOG_URL =
  "https://raw.githubusercontent.com/MiaAI-Lab/sparkDash/main/CHANGELOG.md";
const FETCH_TIMEOUT_MS = 5_000;
/** Reuse a successful answer for six hours. */
export const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;
const RETRY_BASE_MS = 5 * 60 * 1000;
const DOTTED_NUMBERS = /^\d+(?:\.\d+){1,}$/;

/**
 * The `version` field of an upstream manifest, or null when it is missing or
 * not a plain dotted-numeric version. Accepts only strings and never throws.
 * @param {unknown} manifest
 * @returns {string | null}
 */
export function parseManifestVersion(manifest) {
  if (!manifest || typeof manifest !== "object") return null;
  const version = typeof manifest.version === "string" ? manifest.version.trim() : "";
  return DOTTED_NUMBERS.test(version) ? version : null;
}

/**
 * Compare dotted-numeric versions ("2.75.4" vs "2.76.0"). Returns <0 / 0 / >0.
 * Missing segments count as 0. Callers validate both sides first.
 * @param {string} a
 * @param {string} b
 */
export function compareVersions(a, b) {
  const pa = String(a ?? "").split(".");
  const pb = String(b ?? "").split(".");
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const na = parseInt(pa[i] ?? "0", 10);
    const nb = parseInt(pb[i] ?? "0", 10);
    if (!Number.isFinite(na) || !Number.isFinite(nb)) return 0;
    if (na !== nb) return na < nb ? -1 : 1;
  }
  return 0;
}

/**
 * `SPARKDASH_UPDATE_CHECK=off` (also 0/false/no/disabled) disables the outbound
 * check entirely, for air-gapped installs. Anything else leaves it enabled.
 * @param {string | undefined} value
 */
export function updateChecksDisabled(value = process.env.SPARKDASH_UPDATE_CHECK) {
  return /^(?:off|0|false|no|disabled)$/i.test(String(value ?? "").trim());
}

/**
 * Pull the release notes that apply to a newer version out of upstream's
 * CHANGELOG.md: the `[Unreleased]` section plus any versioned sections newer
 * than the running version. Sections are newest-first, and the result is
 * capped so the notice stays small.
 *
 * @param {string} markdown
 * @param {string | null} currentVersion
 * @param {number} [maxChars]
 * @returns {string | null}
 */
export function extractChangelogNotes(markdown, currentVersion, maxChars = 6000) {
  if (typeof markdown !== "string") return null;
  const kept = [];
  let keep = false;
  let seenHeading = false;
  for (const raw of markdown.replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.trimEnd();
    const heading = /^##\s+\[([^\]]+)\]/.exec(line.trim());
    if (heading) {
      seenHeading = true;
      const name = heading[1].trim();
      const version = DOTTED_NUMBERS.test(name) ? name : null;
      keep =
        name.toLowerCase() === "unreleased" ||
        (version !== null && currentVersion !== null && compareVersions(version, currentVersion) > 0);
      if (keep) kept.push(line.trim().replace(/^##\s+\[([^\]]+)\]/, "## $1"));
      continue;
    }
    if (keep) kept.push(line);
  }
  if (!seenHeading || kept.length === 0) return null;
  const notes = kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return notes ? notes.slice(0, maxChars) : null;
}

/**
 * One checker per server process. `status()` is the only entry point: it returns
 * the cached answer, starting a single-flight fetch when the answer is stale.
 *
 * @param {object} [options]
 * @param {string | null} [options.currentVersion] version this process runs
 * @param {string} [options.sourceUrl] upstream manifest URL
 * @param {string} [options.changelogUrl] upstream changelog URL
 * @param {typeof fetch} [options.fetchImpl]
 * @param {() => number} [options.now]
 * @param {number} [options.ttlMs]
 * @param {number} [options.retryBaseMs]
 * @param {boolean} [options.enabled]
 */
export function createUpdateChecker({
  currentVersion = null,
  sourceUrl = DEFAULT_SOURCE_URL,
  changelogUrl = DEFAULT_CHANGELOG_URL,
  fetchImpl = fetch,
  now = Date.now,
  ttlMs = DEFAULT_TTL_MS,
  retryBaseMs = RETRY_BASE_MS,
  enabled = !updateChecksDisabled(),
} = {}) {
  const current =
    typeof currentVersion === "string" && DOTTED_NUMBERS.test(currentVersion.trim())
      ? currentVersion.trim()
      : null;
  /** @type {string | null} */
  let latest = null;
  /** Changelog excerpt that applies to this running version. */
  let notes = null;
  /** Last successful check (ms epoch). */
  let checkedAt = null;
  let failures = 0;
  let nextAttemptAt = 0;
  /** @type {Promise<void> | null} */
  let inFlight = null;

  async function fetchText(url, accept) {
    const res = await fetchImpl(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { Accept: accept, "User-Agent": "sparkdash" },
    });
    if (!res || !res.ok) throw new Error(`upstream ${url} returned HTTP ${res?.status ?? "?"}`);
    return res.text();
  }

  async function check() {
    try {
      const [manifestRes, changelogRes] = await Promise.allSettled([
        fetchText(sourceUrl, "application/json"),
        // Optional: a newer version is still reported when the notes fail.
        fetchText(changelogUrl, "text/plain"),
      ]);
      if (manifestRes.status === "rejected") throw manifestRes.reason;
      const version = parseManifestVersion(JSON.parse(manifestRes.value));
      if (!version) throw new Error("upstream manifest has no usable version");
      latest = version;
      if (changelogRes.status === "fulfilled") {
        const extracted = extractChangelogNotes(changelogRes.value, current);
        if (extracted) notes = extracted;
      }
      checkedAt = now();
      failures = 0;
      nextAttemptAt = 0;
    } catch {
      // Silent by design: an unreachable GitHub must not surface as a dashboard
      // error. Keep the last good answer (if any) and back off before retrying.
      failures += 1;
      const backoff = Math.min(ttlMs, retryBaseMs * 2 ** Math.min(failures - 1, 16));
      // ±20% so installs that started together do not retry in lockstep.
      nextAttemptAt = now() + Math.round(backoff * (0.8 + Math.random() * 0.4));
    }
  }

  return {
    async status() {
      if (enabled) {
        const at = now();
        const stale = checkedAt === null || at - checkedAt >= ttlMs;
        if (!inFlight && stale && at >= nextAttemptAt) {
          inFlight = check().finally(() => {
            inFlight = null;
          });
        }
        if (inFlight) await inFlight;
      }
      return {
        enabled,
        currentVersion: current,
        latestVersion: latest,
        // true: upstream is newer. false: up to date. null: not known (yet).
        updateAvailable: current && latest ? compareVersions(latest, current) > 0 : null,
        /** Release notes for versions newer than `currentVersion`. */
        notes,
        checkedAt,
      };
    },
  };
}
