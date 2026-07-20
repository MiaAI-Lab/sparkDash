import { useState } from "react";
import type { SparkSnapshot } from "../../api/types";
import { shutdownSpark, wakeSpark } from "../../api/client";
import { EditIcon, PowerOffIcon, PowerOnIcon } from "../ui/icons";

interface SparkHeaderProps {
  spark: SparkSnapshot;
  onEdit?: () => void;
}

function formatUptime(seconds: number): string {
  if (seconds < 60) return "<1m";
  const mins = Math.floor(seconds / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const remainMins = mins % 60;
  if (hours < 24) return `${hours}h ${remainMins}m`;
  const days = Math.floor(hours / 24);
  const remainHours = hours % 24;
  return `${days}d ${remainHours}h`;
}

export function SparkHeader({ spark, onEdit }: SparkHeaderProps) {
  const { hardware } = spark;
  const online = spark.online;
  const [powerLoading, setPowerLoading] = useState(false);
  const [powerMsg, setPowerMsg] = useState<{ text: string; tone: "ok" | "err" } | null>(null);

  async function handleShutdown() {
    if (
      !confirm(
        `Gracefully shut down ${spark.name}? This will stop all containers and power off the node.`
      )
    ) {
      return;
    }
    setPowerLoading(true);
    setPowerMsg(null);
    try {
      const res = await shutdownSpark(spark.id);
      setPowerMsg({ text: res.message || "Shutdown initiated", tone: "ok" });
    } catch (err: unknown) {
      setPowerMsg({
        text: err instanceof Error ? err.message : "Shutdown failed",
        tone: "err",
      });
    } finally {
      setPowerLoading(false);
      setTimeout(() => setPowerMsg(null), 5000);
    }
  }

  async function handleWake() {
    setPowerLoading(true);
    setPowerMsg(null);
    try {
      const res = await wakeSpark(spark.id);
      setPowerMsg({ text: res.message || "Wake packet sent", tone: "ok" });
    } catch (err: unknown) {
      setPowerMsg({
        text: err instanceof Error ? err.message : "Wake failed",
        tone: "err",
      });
    } finally {
      setPowerLoading(false);
      setTimeout(() => setPowerMsg(null), 5000);
    }
  }

  return (
    <div
      className="spark-header panel flex flex-wrap items-center gap-x-4 gap-y-2 p-5"
      style={online ? undefined : { opacity: 0.6 }}
    >
      <div className="flex items-center gap-2.5">
        <span
          className={`h-2 w-2 shrink-0 rounded-full ${online ? "bg-success dot-glow-success" : "bg-danger"}`}
          title={online ? "Online" : "Offline"}
        />
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="truncate text-base font-semibold text-text-strong">{spark.name}</h2>
            {online && spark.uptime != null && (
              <span
                className="shrink-0 rounded bg-accent/15 px-1.5 py-0.5 font-tabular text-[10px] font-medium text-accent"
                title={`Uptime: ${formatUptime(spark.uptime)}`}
              >
                {formatUptime(spark.uptime)}
              </span>
            )}
          </div>
          <p className="truncate text-xs text-muted">
            {hardware.device} · {hardware.gpuChip}
          </p>
        </div>
      </div>

      <div className="ml-auto flex items-center gap-2">
        {powerMsg && (
          <span className={`text-[11px] ${powerMsg.tone === "ok" ? "text-success" : "text-danger"}`}>
            {powerMsg.text}
          </span>
        )}
        {online ? (
          <button
            type="button"
            onClick={() => void handleShutdown()}
            disabled={powerLoading}
            title="Graceful shutdown (requires /usr/local/bin/spark-shutdown on the host)"
            className="flex items-center gap-1.5 rounded-md border border-border bg-surface-elevated px-3 py-1.5 text-[11px] text-muted hover:bg-danger/20 hover:text-danger transition-colors disabled:opacity-50"
          >
            <PowerOffIcon className="h-3 w-3" />
            Shutdown
          </button>
        ) : (
          <button
            type="button"
            onClick={() => void handleWake()}
            disabled={powerLoading}
            title="Wake-on-LAN (set MAC address in Edit Spark)"
            className="flex items-center gap-1.5 rounded-md border border-border bg-surface-elevated px-3 py-1.5 text-[11px] text-muted hover:bg-success/20 hover:text-success transition-colors disabled:opacity-50"
          >
            <PowerOnIcon className="h-3 w-3" />
            Wake
          </button>
        )}
        {onEdit && (
          <button
            type="button"
            onClick={onEdit}
            className="flex items-center gap-1.5 rounded-md border border-border bg-surface-elevated px-3 py-1.5 text-[11px] text-muted hover:bg-surface-hover hover:text-text transition-colors"
          >
            <EditIcon className="h-3 w-3" />
            Edit
          </button>
        )}
      </div>
    </div>
  );
}
