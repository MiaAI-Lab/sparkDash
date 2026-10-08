/** Reserved tab id for the cross-Spark overview (not a real Spark). */
export const OVERVIEW_ID = "__overview__";
/** Reserved ids for the dedicated fleet pages. */
export const TOKENS_ID = "__tokens__";
export const ENERGY_ID = "__energy__";
export const ACTIVITY_ID = "__activity__";
/** Benchmark pages: the active id is this prefix + the benchmark type (decode, tool-eval, …). */
export const BENCH_PREFIX = "__bench__:";

const FIXED_PATHS: Record<string, string> = {
  [OVERVIEW_ID]: "/",
  [TOKENS_ID]: "/tokens",
  [ENERGY_ID]: "/energy",
  [ACTIVITY_ID]: "/activity",
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
