import type { StorageContext, StorageFilesystem } from "../../api/types";
import { formatBytes } from "../../shared/formatBytes";
import { mainFilesystem as pickMain, statusView } from "../../shared/mainFilesystem";
import { DiskIcon } from "../ui/icons";
import { usageTone } from "./SparkPicker";

/**
 * The main disk, by the shared mainFilesystem() policy (the one the Spark card above uses too): the disk
 * mounted at "/", else the biggest one. Boot partitions like /boot/efi never count; bind mounts count once.
 */
export function mainFilesystem(filesystems: StorageFilesystem[]): StorageFilesystem | null {
  return pickMain(filesystems, statusView);
}

/** "Runs over SSH as zurih": how the dashboard reaches this Spark. Informative only. */
export function contextText(ctx: StorageContext): string {
  const who = ctx.account ? ` as ${ctx.account}` : "";
  if (ctx.kind === "ssh") return `Runs over SSH${who}`;
  if (ctx.kind === "native-local") return `Runs on this Spark${who}`;
  return `Runs via the dashboard's container${who}`;
}

function contextTitle(ctx: StorageContext): string {
  const where = ctx.hostname ? `On ${ctx.hostname}. ` : "";
  if (ctx.kind === "container-local") {
    return `${where}The dashboard runs in a container and enters the Spark's file system from there, so the account, home folder and environment are the container's.`;
  }
  if (ctx.kind === "native-local") return `${where}The dashboard runs directly on this Spark and starts the commands itself.`;
  return `${where}Commands run over SSH as the account set for this Spark.`;
}

/** How full the main disk is, so it is clear what there is to win back. */
export function DiskSummary({ filesystems, context = null }: { filesystems: StorageFilesystem[]; context?: StorageContext | null }) {
  const main = mainFilesystem(filesystems);
  if (!main) return null;
  return (
    <section className="panel st-disks" aria-label="Main disk">
      {[main].map((fs) => {
        const pct = fs.totalBytes > 0 ? Math.min(100, Math.round((fs.usedBytes / fs.totalBytes) * 100)) : 0;
        const tone = usageTone(pct);
        return (
          <div key={fs.source} className="st-disk">
            <div className="st-disk__head">
              <span className="st-disk__name">
                <DiskIcon className="h-4 w-4" />
                <b>{fs.mount === "/" ? "Main disk" : fs.mount}</b>
                <span className="st-disk__dev mono">
                  {fs.source} · {fs.fstype}
                </span>
              </span>
              <span className={`st-disk__free is-${tone}`}>{formatBytes(fs.availBytes)} free</span>
            </div>
            <div
              className="st-bar"
              role="meter"
              aria-label={`${fs.mount === "/" ? "Main disk" : fs.mount} used`}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={pct}
            >
              <i className={`is-${tone}`} style={{ ["--w" as string]: `${pct}%` }} />
            </div>
            <div className="st-disk__foot">
              <span>
                {formatBytes(fs.usedBytes)} used of {formatBytes(fs.totalBytes)}
              </span>
              <span>{pct}% full</span>
            </div>
            {pct >= 90 ? (
              <p className="st-disk__warn" role="status">
                This disk is almost full. Models may fail to download or load until some space is freed.
              </p>
            ) : null}
            {context ? (
              <p className="st-disk__ctx" title={contextTitle(context)}>
                {contextText(context)}
              </p>
            ) : null}
          </div>
        );
      })}
    </section>
  );
}
