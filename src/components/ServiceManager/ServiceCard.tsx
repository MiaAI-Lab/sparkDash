import type { ReactNode } from "react";
import type { ServiceInstance } from "../../../shared/types";
import { Panel } from "../ui/Panel";
import { timeAgo } from "../../lib/timeAgo";

export interface ServiceCardProps {
  /** Service name (matches the node-agent recipe name). */
  name: string;
  /** Service kind. An empty string (legacy rows) renders as "other". */
  kind: ServiceInstance["kind"];
  /** Engine: sglang / vllm / comfyui / qwen3-tts / qwen3-asr / matrix-voip / other. */
  engine: string;
  /** Port this service listens on. */
  port: number;
  status: ServiceInstance["status"];
  /** Live model id. null when not running or unknown. */
  modelId: string | null;
  /** Live engine version. null when not running or unknown. */
  engineVersion: string | null;
  /** Memory footprint in MB. */
  footprintMB: number;
  /** true when this service is the active LLM. */
  active: boolean;
  /** Last time this service state was polled (ms epoch). */
  polledAt: number;
  onStart: () => void;
  onStop: () => void;
  onSwitch: () => void;
}

function formatMb(mb: number): string {
  if (!Number.isFinite(mb) || mb < 0) return "—";
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${Math.round(mb)} MB`;
}

/** Semantic status chip. Style mirrors GpuPanel's throttle badge. */
export const STATUS_STYLES: Record<ServiceInstance["status"], { label: string; className: string }> =
  {
    running: { label: "running", className: "border-accent/40 bg-accent/15 text-accent" },
    stopped: { label: "stopped", className: "border-border bg-surface-elevated text-muted" },
    loading: { label: "loading", className: "border-warning/40 bg-warning/15 text-warning" },
    wedged: { label: "wedged", className: "border-danger/40 bg-danger/15 text-danger" },
    unknown: { label: "unknown", className: "border-border bg-surface-elevated text-muted" },
  };

export function StatusBadge({ status }: { status: ServiceInstance["status"] }) {
  const s = STATUS_STYLES[status] ?? STATUS_STYLES.unknown;
  return (
    <span
      className={`rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${s.className}`}
    >
      {s.label}
    </span>
  );
}

/** Neutral kind chip — status carries the semantic color, kind stays neutral. */
export function KindBadge({ kind }: { kind: ServiceInstance["kind"] }) {
  return (
    <span className="rounded border border-border bg-surface-elevated px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted">
      {kind || "other"}
    </span>
  );
}

function Row({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2 text-sm">
      <span className="text-muted">{label}</span>
      <span
        className="min-w-0 truncate font-tabular text-sm text-text"
        title={typeof value === "string" ? value : undefined}
      >
        {value}
      </span>
    </div>
  );
}

/**
 * One service instance card (start / stop / switch).
 *
 * Button visibility:
 * - Start: whenever status !== "running"
 * - Stop:  whenever status !== "stopped"
 * - Switch: only while indeterminate (loading / wedged / unknown) — a running
 *   service already serves its model, and a stopped one has nothing to switch onto.
 */
export function ServiceCard({
  name,
  kind,
  engine,
  port,
  status,
  modelId,
  engineVersion,
  footprintMB,
  active,
  polledAt,
  onStart,
  onStop,
  onSwitch,
}: ServiceCardProps) {
  const showStart = status !== "running";
  const showStop = status !== "stopped";
  const showSwitch = status !== "running" && status !== "stopped";

  return (
    <Panel
      title={name}
      accent={active}
      actions={
        <div className="flex items-center gap-1.5">
          <KindBadge kind={kind} />
          <StatusBadge status={status} />
        </div>
      }
      bodyClassName="space-y-2"
    >
      <Row label="Engine" value={engineVersion ? `${engine} ${engineVersion}` : engine || "—"} />
      <Row label="Model" value={modelId ?? "—"} />
      <Row label="Port" value={Number.isFinite(port) && port > 0 ? String(port) : "—"} />
      <Row label="Footprint" value={formatMb(footprintMB)} />
      <Row
        label="Active"
        value={
          active ? (
            <span className="rounded border border-accent/40 bg-accent/15 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-accent">
              ACTIVE
            </span>
          ) : (
            "—"
          )
        }
      />
      <Row label="Polled" value={timeAgo(polledAt)} />
      {(showStart || showStop || showSwitch) && (
        <div className="flex items-center gap-2 border-t border-border pt-2">
          {showStart && (
            <button
              type="button"
              onClick={onStart}
              aria-label={`Start ${name}`}
              className="rounded bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-hover"
            >
              Start
            </button>
          )}
          {showStop && (
            <button
              type="button"
              onClick={onStop}
              aria-label={`Stop ${name}`}
              className="rounded border border-danger/40 px-3 py-1.5 text-xs font-medium text-danger hover:bg-danger/10"
            >
              Stop
            </button>
          )}
          {showSwitch && (
            <button
              type="button"
              onClick={onSwitch}
              aria-label={`Switch ${name}`}
              className="rounded border border-border px-3 py-1.5 text-xs text-muted hover:bg-surface-hover"
            >
              Switch
            </button>
          )}
        </div>
      )}
    </Panel>
  );
}
