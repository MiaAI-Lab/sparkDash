/** Reserved tab id for the cross-Spark overview (not a real Spark). */
export const OVERVIEW_ID = "__overview__";
/** Reserved ids for the dedicated fleet pages. */
export const TOKENS_ID = "__tokens__";
export const ENERGY_ID = "__energy__";
export const ACTIVITY_ID = "__activity__";
export const SHOWCASE_ID = "__showcase__";
/** Benchmark pages: the active id is this prefix + the benchmark type (decode, tool-eval, …). */
export const BENCH_PREFIX = "__bench__:";

const FIXED_PATHS: Record<string, string> = {
  [OVERVIEW_ID]: "/",
  [TOKENS_ID]: "/tokens",
  [ENERGY_ID]: "/energy",
  [ACTIVITY_ID]: "/activity",
  [SHOWCASE_ID]: "/showcase",
};

export function benchId(type: string): string {
  return `${BENCH_PREFIX}${type}`;
}

/** Benchmark type when `id` is a benchmark page id, otherwise null. */
export function benchTypeOf(id: string | null | undefined): string | null {
  return id && id.startsWith(BENCH_PREFIX) ? id.slice(BENCH_PREFIX.length) : null;
}

/** True for every id that is a page rather than a Spark. */
export function isPageId(id: string | null | undefined): boolean {
  return Boolean(id) && (id! in FIXED_PATHS || id!.startsWith(BENCH_PREFIX));
}

/** URL path for an active id (a Spark id gets its detail page; null is the overview). */
export function idToPath(id: string | null): string {
  if (!id) return "/";
  if (id in FIXED_PATHS) return FIXED_PATHS[id];
  const bench = benchTypeOf(id);
  if (bench) return `/bench/${encodeURIComponent(bench)}`;
  return `/spark/${encodeURIComponent(id)}`;
}

/** Active id for a URL path, or null when the path is not an app page (e.g. /showcase/...). */
export function pathToId(pathname: string): string | null {
  if (pathname.startsWith("/showcase/")) return null;
  for (const [id, p] of Object.entries(FIXED_PATHS)) {
    if (p !== "/" && (pathname === p || pathname === `${p}/`)) return id;
  }
  const bench = pathname.match(/^\/bench\/([a-z0-9-]+)\/?$/);
  if (bench) return benchId(bench[1]);
  const spark = pathname.match(/^\/spark\/([^/]+)/);
  if (spark) return decodeURIComponent(spark[1]);
  return OVERVIEW_ID;
}

/** Active id for the URL the page was opened on, read synchronously so a deep link never paints Overview first. */
export function initialActiveId(): string {
  try {
    const path = window.location.pathname;
    if (typeof path !== "string") return OVERVIEW_ID;
    return pathToId(path) ?? OVERVIEW_ID;
  } catch {
    return OVERVIEW_ID;
  }
}

/**
 * True when `activeId` names a Spark that is not in the fleet any more, so the URL should be
 * replaced with the Overview. Pages and the Overview are always valid, and nothing is judged
 * before the first fleet list has arrived (`loaded`).
 */
export function isStaleSparkId(
  activeId: string | null | undefined,
  sparkIds: readonly string[],
  loaded: boolean
): boolean {
  if (!loaded || !activeId || activeId === OVERVIEW_ID || isPageId(activeId)) return false;
  return !sparkIds.includes(activeId);
}
