import type { ReactNode } from "react";
import { Panel } from "../ui/Panel";
import { timeAgo } from "../../lib/timeAgo";

export interface RequestStatCardProps {
  modelId: string;
  /** Engine: sglang / vllm / comfyui / qwen3-tts / qwen3-asr / matrix-voip / other. */
  engine: string;
  /** Machine (node id). */
  nodeId: string;
  port: number;
  /** Queued requests (waiting). */
  queued: number;
  /** Running requests (active). */
  running: number;
  /** Finished requests (cumulative since boot). */
  finished: number;
  /** Last time this stat was polled (ms epoch). */
  polledAt: number;
}

function num(n: number): string {
  return Number.isFinite(n) ? String(n) : "—";
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

/** One model/engine/machine request stat (queued / running / finished). */
export function RequestStatCard({
  modelId,
  engine,
  nodeId,
  port,
  queued,
  running,
  finished,
  polledAt,
}: RequestStatCardProps) {
  const machine = port > 0 && Number.isFinite(port) ? `${nodeId || "—"}:${port}` : nodeId || "—";

  return (
    <Panel
      title={modelId || "—"}
      actions={
        <span className="rounded border border-border bg-surface-elevated px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted">
          {engine || "other"}
        </span>
      }
      bodyClassName="space-y-2"
    >
      <Row label="Machine" value={machine} />
      <Row label="Queued" value={num(queued)} />
      <Row label="Running" value={num(running)} />
      <Row label="Finished" value={num(finished)} />
      <Row label="Polled" value={timeAgo(polledAt)} />
    </Panel>
  );
}
