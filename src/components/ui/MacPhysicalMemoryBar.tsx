import { useTranslation } from "react-i18next";
import type { MacPhysicalMemory, UnifiedMemoryMetrics } from "../../api/types";
import { formatMb } from "../../shared/formatBytes";
import { Tag } from "./Tag";

const categories: Array<keyof MacPhysicalMemory> = ["apps", "wired", "compressed", "cached", "other", "free"];
const colors = { apps: "bg-info", wired: "bg-violet", compressed: "bg-accent", cached: "mac-memory-cache", other: "bg-muted", free: "bg-surface-hover" };

/** Physical RAM composition; reclaimable cache is occupied RAM, while swap stays outside the bar. */
export function MacPhysicalMemoryBar({ memory }: {
  memory: Pick<UnifiedMemoryMetrics, "total" | "used" | "physical" | "memoryPressure" | "swap">;
}) {
  const { t } = useTranslation("spark");
  const pressure = memory.memoryPressure ?? "unknown";
  const physical = memory.physical;
  const labels = {
    apps: t("memory.physical.apps"), wired: t("memory.physical.wired"), compressed: t("memory.physical.compressed"),
    cached: t("memory.physical.cached"), other: t("memory.physical.other"), free: t("memory.physical.free"),
  };
  const help = {
    apps: t("memory.physical.appsHelp"), wired: t("memory.physical.wiredHelp"), compressed: t("memory.physical.compressedHelp"),
    cached: t("memory.physical.cachedHelp"), other: t("memory.physical.otherHelp"), free: t("memory.physical.freeHelp"),
  };
  const pressureLabels = {
    normal: t("memory.physical.pressureStates.normal"), warning: t("memory.physical.pressureStates.warning"),
    critical: t("memory.physical.pressureStates.critical"), unknown: t("memory.physical.pressureStates.unknown"),
  };
  return (
    <div className="space-y-2" data-mac-memory>
      <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-1">
        <span className="text-xs text-muted">{t("memory.physical.title")}</span>
        <span className="font-tabular text-xs text-text">
          {memory.total > 0 ? t("memory.physical.usedOf", { used: formatMb(memory.used), total: formatMb(memory.total) }) : "—"}
        </span>
      </div>
      {physical ? (
        <>
          <div className="flex h-2 overflow-hidden rounded-full bg-border" role="img" aria-label={t("memory.physical.title")}>
            {categories.map((key) => (
              <span
                key={key}
                data-memory-segment={key}
                className={`metric-bar-fill h-full shrink-0 ${colors[key]}`}
                style={{ ["--bar-pct" as string]: `${memory.total > 0 ? physical[key] / memory.total * 100 : 0}%` }}
                title={`${labels[key]}: ${formatMb(physical[key])}. ${help[key]}`}
              />
            ))}
          </div>
          <div className="flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-muted">
            {categories.map((key) => (
              <span className="inline-flex items-center gap-1" key={key} title={help[key]}>
                <i aria-hidden className={`inline-block h-2 w-2 rounded-sm border border-border ${colors[key]}`} />
                {labels[key]} <span className="font-tabular">{formatMb(physical[key])}</span>
              </span>
            ))}
          </div>
        </>
      ) : <p className="text-xs text-muted">{t("memory.physical.unavailable")}</p>}
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
        <span data-memory-pressure={pressure}>
          {t("memory.physical.pressure")} {" "}
          <Tag tone={pressure === "normal" ? "good" : pressure === "warning" ? "warn" : pressure === "critical" ? "bad" : "neutral"}>
            {pressureLabels[pressure]}
          </Tag>
        </span>
        {memory.swap ? <span>{t("memory.physical.swap", { value: formatMb(memory.swap.used) })}</span> : null}
      </div>
    </div>
  );
}
