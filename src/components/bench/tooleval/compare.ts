import type { ToolEvalRun } from "../../../api/types";
import { CATEGORY_NAMES, flattenNumbers, normalizeToolResult, type NormToolResult, type ScenarioStatus } from "./normalize";

export interface Delta {
  label: string;
  a: number | null;
  b: number | null;
  /** b - a (null when either side is missing) */
  delta: number | null;
  /** true: a bigger number is better. false: smaller is better. */
  higherIsBetter: boolean;
  /** Decimals that make a real change visible (0 for counts, more for 0-1 scales). */
  digits: number;
}

/** Decimals to show a change between a and b: counts get 0, 0-1 ratios 3, anything else 1. */
export function deltaDigits(a: number | null, b: number | null, count = false): number {
  if (count) return 0;
  const scale = Math.max(Math.abs(a ?? 0), Math.abs(b ?? 0));
  return scale > 0 && scale <= 1 ? 3 : 1;
}

export interface ScenarioChange {
  id: string;
  title: string | null;
  category: string | null;
  from: ScenarioStatus | null;
  to: ScenarioStatus | null;
  kind: "regression" | "improvement" | "changed" | "only-a" | "only-b";
}

/** One scenario across both runs; `same` rows are the ones that did not change. */
export interface ScenarioRow {
  id: string;
  title: string | null;
  category: string | null;
  from: ScenarioStatus | null;
  to: ScenarioStatus | null;
  kind: ScenarioChange["kind"] | "same";
}

export interface ToolCompare {
  headline: Delta[];
  categories: (Delta & { id: string; name: string | null })[];
  /** Every scenario of either run, in id order. */
  rows: ScenarioRow[];
  /** Only the rows that differ, worst first. */
  changes: ScenarioChange[];
  unchanged: number;
  /** Whether each side carries per-scenario data at all (a result may have only category scores). */
  hasScenarios: { a: boolean; b: boolean };
}

const RANK: Record<ScenarioStatus, number> = { pass: 3, partial: 2, fail: 1, other: 0 };

const d = (label: string, a: number | null, b: number | null, higherIsBetter = true, count = false): Delta => ({
  label,
  a,
  b,
  delta: a != null && b != null ? b - a : null,
  higherIsBetter,
  digits: deltaDigits(a, b, count),
});

/** Compare two tool-call results: `a` is the baseline, `b` the newer one. */
export function compareToolResults(a: NormToolResult, b: NormToolResult): ToolCompare {
  const hasScenarios = { a: a.scenarios.length > 0, b: b.scenarios.length > 0 };
  // Counts come from scenarios: a side without any has no counts, not zero of everything.
  const cnt = (n: NormToolResult, has: boolean, k: "pass" | "partial" | "fail") => (has ? n.counts[k] : null);
  const headline = [
    d("Score", a.score, b.score),
    d("Deployability", a.deployability, b.deployability),
    d("Responsiveness", a.responsiveness, b.responsiveness),
    d("Passed", cnt(a, hasScenarios.a, "pass"), cnt(b, hasScenarios.b, "pass"), true, true),
    d("Partial", cnt(a, hasScenarios.a, "partial"), cnt(b, hasScenarios.b, "partial"), true, true),
    d("Failed", cnt(a, hasScenarios.a, "fail"), cnt(b, hasScenarios.b, "fail"), false, true),
    d("Safety warnings", a.safety.length, b.safety.length, false, true),
  ];
  const ids = [...new Set([...a.categories.map((c) => c.id), ...b.categories.map((c) => c.id)])].sort();
  const categories = ids.map((id) => {
    const ca = a.categories.find((c) => c.id === id);
    const cb = b.categories.find((c) => c.id === id);
    return { ...d(id, ca?.percent ?? null, cb?.percent ?? null), id, name: ca?.name ?? cb?.name ?? CATEGORY_NAMES[id] ?? null };
  });
  const mapA = new Map(a.scenarios.map((s) => [s.id, s]));
  const mapB = new Map(b.scenarios.map((s) => [s.id, s]));
  const rows: ScenarioRow[] = [];
  for (const id of new Set([...mapA.keys(), ...mapB.keys()])) {
    const sa = mapA.get(id);
    const sb = mapB.get(id);
    const base = { id, title: sb?.title ?? sa?.title ?? null, category: sb?.category ?? sa?.category ?? null, from: sa?.status ?? null, to: sb?.status ?? null };
    let kind: ScenarioRow["kind"];
    if (sa && !sb) kind = "only-a";
    else if (!sa && sb) kind = "only-b";
    else if (sa && sb) kind = sa.status === sb.status ? "same" : RANK[sb.status] < RANK[sa.status] ? "regression" : RANK[sb.status] > RANK[sa.status] ? "improvement" : "changed";
    else continue;
    rows.push({ ...base, kind });
  }
  rows.sort((x, y) => x.id.localeCompare(y.id, undefined, { numeric: true }));
  const order = { regression: 0, improvement: 1, changed: 2, "only-a": 3, "only-b": 4 } as const;
  const changes = rows.filter((r): r is ScenarioChange => r.kind !== "same").sort((x, y) => order[x.kind] - order[y.kind] || x.id.localeCompare(y.id, undefined, { numeric: true }));
  return { headline, categories, rows, changes, unchanged: rows.length - changes.length, hasScenarios };
}

export interface MetricChange {
  path: string;
  a: number | null;
  b: number | null;
  delta: number | null;
  /** relative change in percent, null when a is 0 or missing */
  pct: number | null;
}

/** Generic diff for non-scenario results: every numeric leaf present in either, changed ones first. */
export function compareGeneric(a: unknown, b: unknown, limit = 200): { changed: MetricChange[]; same: number } {
  const fa = flattenNumbers(a);
  const fb = flattenNumbers(b);
  const changed: MetricChange[] = [];
  let same = 0;
  for (const path of new Set([...Object.keys(fa), ...Object.keys(fb)])) {
    const x = fa[path] ?? null;
    const y = fb[path] ?? null;
    if (x === y) {
      same += 1;
      continue;
    }
    const delta = x != null && y != null ? y - x : null;
    changed.push({ path, a: x, b: y, delta, pct: x != null && y != null && x !== 0 ? ((y - x) / Math.abs(x)) * 100 : null });
  }
  changed.sort((p, q) => Math.abs(q.pct ?? 0) - Math.abs(p.pct ?? 0) || p.path.localeCompare(q.path));
  return { changed: changed.slice(0, limit), same };
}

const IGNORED_OPTIONS = new Set(["label", "output-dir", "api-key", "header", "diff", "resume"]);

/** Differences in model / endpoint / options that make a comparison less meaningful. */
export function configCaveats(a: Pick<ToolEvalRun, "model" | "baseUrl" | "options" | "type">, b: Pick<ToolEvalRun, "model" | "baseUrl" | "options" | "type">): string[] {
  const out: string[] = [];
  if (a.type !== b.type) out.push("The runs are of different benchmark types.");
  if ((a.model ?? "") !== (b.model ?? "")) out.push(`Different models: ${a.model ?? "auto"} vs ${b.model ?? "auto"}.`);
  if (a.baseUrl !== b.baseUrl) out.push(`Different endpoints: ${a.baseUrl} vs ${b.baseUrl}.`);
  const keys = new Set([...Object.keys(a.options ?? {}), ...Object.keys(b.options ?? {})]);
  const differing: string[] = [];
  for (const k of keys) {
    if (IGNORED_OPTIONS.has(k) || k === "model" || k === "base-url") continue;
    if (JSON.stringify(a.options?.[k] ?? null) !== JSON.stringify(b.options?.[k] ?? null)) differing.push(k);
  }
  if (differing.length) out.push(`Different options: ${differing.map((k) => `--${k}`).join(", ")}.`);
  return out;
}

export function normalizeForCompare(result: unknown): NormToolResult | null {
  const n = normalizeToolResult(result);
  return n && (n.scenarios.length || n.categories.length) ? n : null;
}
