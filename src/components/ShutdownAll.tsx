import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { SparkSnapshot } from "../api/types";
import { shutdownAllSparks } from "../api/client";
import { ConfirmShutdownDialog } from "./ConfirmShutdownDialog";
import { shutdownWarnings } from "./OverviewPage/fleetStats";
import { PowerOffIcon } from "./ui/icons";

/**
 * "Shut down all" with its confirmation and result message. Used in the Overview header (desktop)
 * and in the mobile Sparks sheet, so the flow exists once.
 */
export function ShutdownAll({ sparks, className = "" }: { sparks: SparkSnapshot[]; className?: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; tone: "ok" | "err" } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const onlineCount = sparks.filter((s) => s.online).length;

  async function run() {
    if (onlineCount === 0) return;
    setBusy(true);
    setMsg(null);
    try {
      const res = await shutdownAllSparks();
      const ok = res.results.filter((r) => r.ok).length;
      const fail = res.results.filter((r) => !r.ok && !r.skipped).length;
      const skipped = res.results.filter((r) => r.skipped).length;
      const parts = [t("overview.shutdownAll.result.shutDown", "{count} shut down", { count: ok })];
      if (fail) parts.push(t("overview.shutdownAll.result.failed", "{count} failed", { count: fail }));
      if (skipped) parts.push(t("overview.shutdownAll.result.skipped", "{count} skipped", { count: skipped }));
      setMsg({ text: parts.join(", "), tone: fail === 0 ? "ok" : "err" });
    } catch (err: unknown) {
      setMsg({ text: err instanceof Error ? err.message : t("overview.shutdownAll.error", "Batch shutdown failed"), tone: "err" });
    } finally {
      setBusy(false);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setMsg(null), 6000);
    }
  }

  return (
    <>
      {msg ? (
        <span className={`ov-batchmsg ${msg.tone === "ok" ? "is-ok" : "is-err"}`} role="status">
          {msg.text}
        </span>
      ) : null}
      <button
        type="button"
        onClick={() => setOpen(true)}
        disabled={busy || onlineCount === 0}
        title={t("overview.shutdownAll.tooltip", "Shut down all online Sparks")}
        className={`btn btn--danger ${className}`}
      >
        <PowerOffIcon className="h-3.5 w-3.5" />
        {t("overview.shutdownAll.button", "Shut down all")}
      </button>
      <ConfirmShutdownDialog
        open={open}
        onClose={() => setOpen(false)}
        onConfirm={run}
        title={t("overview.shutdownAll.title", "Shutdown All")}
        description={t(
          "overview.shutdownAll.description",
          "Gracefully shut down all {count, plural, one {# online Spark} other {# online Sparks}}? Offline nodes will be skipped.",
          { count: onlineCount }
        )}
        confirmLabel={t("overview.shutdownAll.confirmLabel", "Shut down all")}
        warnings={shutdownWarnings(sparks)}
      />
    </>
  );
}
