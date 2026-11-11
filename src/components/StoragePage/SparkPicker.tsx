import type { SparkSnapshot } from "../../api/types";
import { formatBytes } from "../../shared/formatBytes";
import { mainFilesystem, metricsView } from "../../shared/mainFilesystem";
import { Tag } from "../ui/Tag";

const MB = 1024 * 1024;

/**
 * The unit's main disk from the live snapshot, in bytes (the snapshot reports megabytes). Picked by the shared
 * mainFilesystem() policy, the same one the disk summary below uses, so the card and the summary always
 * describe the same disk. Devices hidden from monitoring in Settings still count here: the summary cannot see
 * that setting, and both must agree.
 */
export function mainDisk(spark: SparkSnapshot): { usedBytes: number; totalBytes: number } | null {
  const main = mainFilesystem(Array.isArray(spark.metrics?.storage) ? spark.metrics.storage : [], metricsView);
  return main ? { usedBytes: main.used * MB, totalBytes: main.total * MB } : null;
}

/** Storage Manager supports DGX Spark units only: not the GPU hosts (Windows PCs, Macs). */
export function isStorageSpark(spark: SparkSnapshot): boolean {
  return spark.kind !== "host" && spark.platform !== "darwin" && spark.platform !== "windows";
}

export function usageTone(pct: number): "good" | "warn" | "bad" {
  return pct >= 90 ? "bad" : pct >= 75 ? "warn" : "good";
}

interface SparkPickerProps {
  sparks: SparkSnapshot[];
  activeId: string | null;
  onSelect: (id: string) => void;
}

/**
 * One card per Spark, with its disk fill at a glance. Picking one loads its disks below. An offline Spark can
 * be picked too, to look at its saved analysis; the page then says what cannot be done until it is back.
 */
export function SparkPicker({ sparks, activeId, onSelect }: SparkPickerProps) {
  return (
    <div className="st-picker" role="radiogroup" aria-label="Spark to analyse">
      {sparks.map((s) => {
        // An offline unit's disk numbers are not current: say it is offline instead of showing old ones.
        const disk = s.online ? mainDisk(s) : null;
        const pct = disk ? Math.min(100, Math.round((disk.usedBytes / disk.totalBytes) * 100)) : null;
        const active = s.id === activeId;
        return (
          <button
            key={s.id}
            type="button"
            role="radio"
            aria-checked={active}
            className={`st-spark${active ? " is-active" : ""}${s.online ? "" : " is-offline"}`}
            onClick={() => onSelect(s.id)}
          >
            <span className="st-spark__top">
              <i className={`sdot${s.online ? "" : " sdot--off"}`} aria-hidden />
              <span className="st-spark__name">{s.name}</span>
              {!s.online ? <Tag>Offline</Tag> : null}
            </span>
            {disk && pct != null ? (
              <>
                <span className="st-spark__bar" aria-hidden>
                  <i className={`is-${usageTone(pct)}`} style={{ ["--w" as string]: `${pct}%` }} />
                </span>
                <span className="st-spark__sub">
                  {formatBytes(disk.usedBytes)} used of {formatBytes(disk.totalBytes)}
                </span>
              </>
            ) : (
              <span className="st-spark__sub">{s.online ? "Disk size not reported yet" : "Not reachable · saved results only"}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
