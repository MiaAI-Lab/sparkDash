import type { MetricGap, SparkSnapshot } from "../../api/types";

/**
 * Platform identity + honest availability for overview cards and panels.
 *
 * sparkDash grew on DGX Sparks, where every tile has a real number. A Mac (or
 * any future non-DGX platform) simply cannot answer some of those questions —
 * GPU power without root, GPU temperature, NVIDIA throttle state — and a zero
 * there reads like "idle and cool" rather than "not measurable on this box".
 * Nodes report their gaps explicitly (`metrics.unavailable`, filled by the Mac
 * node agent) and the UI renders the declared reason instead of a zero.
 */

type PlatformKey = "spark" | "host" | "mac";

const PLATFORMS: Record<PlatformKey, { label: string; title: string; className: string }> = {
  spark: {
    label: "DGX",
    title: "NVIDIA DGX Spark",
    className: "bg-accent/10 text-accent",
  },
  mac: {
    label: "Mac",
    title: "Apple Silicon Mac (macOS)",
    className: "bg-warning/15 text-warning",
  },
  host: {
    label: "Host",
    title: "Linux GPU host",
    className: "bg-border/60 text-muted",
  },
};

export function platformKey(spark: Pick<SparkSnapshot, "kind"> | null | undefined): PlatformKey {
  return spark?.kind === "mac" || spark?.kind === "host" ? spark.kind : "spark";
}

/** True for any unit that is not a DGX Spark — DGX-only tiles must not read 0. */
export function isNonDgxPlatform(spark: Pick<SparkSnapshot, "kind"> | null | undefined): boolean {
  return platformKey(spark) !== "spark";
}

/**
 * Platform badge. Distinct from the cluster-role badge (Head/Worker/Standalone):
 * this one says what the machine is, so a Mac in a fleet of Sparks is never
 * mistaken for one.
 */
export function PlatformBadge({
  spark,
  className = "",
}: {
  spark: Pick<SparkSnapshot, "kind">;
  className?: string;
}) {
  const platform = PLATFORMS[platformKey(spark)];
  return (
    <span
      data-testid="platform-badge"
      title={platform.title}
      className={`shrink-0 rounded border border-border/60 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${platform.className} ${className}`}
    >
      {platform.label}
    </span>
  );
}

/** The declared gap for a metric on this node, from the collector or the agent. */
export function gapFor(
  spark: Pick<SparkSnapshot, "metrics"> | null | undefined,
  metric: string
): MetricGap | null {
  const rows: MetricGap[] = [
    ...(spark?.metrics?.unavailable ?? []),
    ...(spark?.metrics?.gpu?.unavailable ?? []),
  ];
  return rows.find((row) => row?.metric === metric) ?? null;
}

/**
 * Render a DGX-only reading honestly: the declared "unavailable" text when the
 * node said it cannot measure this, otherwise the caller's formatted value.
 */
export function honestGap(
  gaps: MetricGap[] | null | undefined,
  metric: string,
  value: string,
  { nonDgx = false }: { nonDgx?: boolean } = {}
): { text: string; title?: string; muted: boolean } {
  const gap = (gaps ?? []).find((row) => row?.metric === metric) ?? null;
  if (gap) return { text: "unavailable", title: gap.reason, muted: true };
  if (nonDgx) {
    return {
      text: "unavailable",
      title: `${metric} is not reported by this platform`,
      muted: true,
    };
  }
  return { text: value, muted: false };
}

/** Spark-level convenience wrapper over honestGap. */
export function honestValue(
  spark: Pick<SparkSnapshot, "kind" | "metrics"> | null | undefined,
  metric: string,
  value: string,
  { fallbackForNonDgx = false }: { fallbackForNonDgx?: boolean } = {}
): { text: string; title?: string; muted: boolean } {
  return honestGap(spark?.metrics?.unavailable ?? spark?.metrics?.gpu?.unavailable, metric, value, {
    nonDgx: fallbackForNonDgx && isNonDgxPlatform(spark),
  });
}
