import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
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
function contextText(ctx: StorageContext, t: TFunction<"storage">): string {
  const account = ctx.account;
  if (ctx.kind === "ssh") return account ? t("disk.sshAccount", { account }) : t("disk.ssh");
  if (ctx.kind === "native-local") return account ? t("disk.localAccount", { account }) : t("disk.local");
  return account ? t("disk.containerAccount", { account }) : t("disk.container");
}

function contextTitle(ctx: StorageContext, t: TFunction<"storage">): string {
  const where = ctx.hostname ? t("disk.host", { hostname: ctx.hostname }) : "";
  if (ctx.kind === "container-local") {
    return where + t("disk.containerHelp");
  }
  if (ctx.kind === "native-local") return where + t("disk.localHelp");
  return where + t("disk.sshHelp");
}

/** How full the main disk is, so it is clear what there is to win back. */
export function DiskSummary({ filesystems, context = null }: { filesystems: StorageFilesystem[]; context?: StorageContext | null }) {
  const { t } = useTranslation("storage");
  const main = mainFilesystem(filesystems);
  if (!main) return null;
  return (
    <section className="panel st-disks" aria-label={t("disk.main")}>
      {[main].map((fs) => {
        const pct = fs.totalBytes > 0 ? Math.min(100, Math.round((fs.usedBytes / fs.totalBytes) * 100)) : 0;
        const tone = usageTone(pct);
        const name = fs.mount === "/" ? t("disk.main") : fs.mount;
        return (
          <div key={fs.source} className="st-disk">
            <div className="st-disk__head">
              <span className="st-disk__name">
                <DiskIcon className="h-4 w-4" />
                <b>{name}</b>
                <span className="st-disk__dev mono">
                  {fs.source} · {fs.fstype}
                </span>
              </span>
              <span className={`st-disk__free is-${tone}`}>{t("disk.free", { size: formatBytes(fs.availBytes) })}</span>
            </div>
            <div
              className="st-bar"
              role="meter"
              aria-label={t("disk.usedLabel", { name })}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={pct}
            >
              <i className={`is-${tone}`} style={{ ["--w" as string]: `${pct}%` }} />
            </div>
            <div className="st-disk__foot">
              <span>
                {t("disk.usedOf", { used: formatBytes(fs.usedBytes), total: formatBytes(fs.totalBytes) })}
              </span>
              <span>{t("disk.full", { percent: pct })}</span>
            </div>
            {pct >= 90 ? (
              <p className="st-disk__warn" role="status">
                {t("disk.almostFull")}
              </p>
            ) : null}
            {context ? (
              <p className="st-disk__ctx" title={contextTitle(context, t)}>
                {contextText(context, t)}
              </p>
            ) : null}
          </div>
        );
      })}
    </section>
  );
}
