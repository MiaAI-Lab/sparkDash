import type { MakeRoomEntry, MemoryService } from "../../../shared/types";
import { Panel } from "../ui/Panel";
import { MetricBar } from "../ui/MetricBar";
import { MemoryIcon } from "../ui/icons";

export interface MemoryBudgetProps {
  totalMB: number;
  usedMB: number;
  freeMB: number;
  servicesUsedMB: number;
  otherUsedMB: number;
  services: MemoryService[];
  /** Make-room plan: which services to stop to free the wanted MB. */
  makeRoom: MakeRoomEntry[];
  needMakeRoom: boolean;
  className?: string;
}

function formatMb(mb: number): string {
  if (!Number.isFinite(mb) || mb < 0) return "—";
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${Math.round(mb)} MB`;
}

function safePct(value: number, max: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(max) || max <= 0) return 0;
  return Math.min(100, Math.max(0, Math.round((value / max) * 100)));
}

/**
 * Memory-budgeting panel: total/used/free, per-service footprints, and the
 * make-room plan used by LLM auto-switch (which services to stop to fit the
 * wanted model). Panel/bar style mirrors RamPanel.
 */
export function MemoryBudget({
  totalMB,
  usedMB,
  freeMB,
  servicesUsedMB,
  otherUsedMB,
  services,
  makeRoom,
  needMakeRoom,
  className,
}: MemoryBudgetProps) {
  const svcs = services ?? [];
  const plan = makeRoom ?? [];
  const freePct = safePct(freeMB, totalMB);

  return (
    <Panel
      title="Memory Budget"
      icon={<MemoryIcon />}
      accent
      actions={
        needMakeRoom ? (
          <span className="rounded border border-danger/40 bg-danger/15 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-danger">
            Make room needed
          </span>
        ) : (
          <span className="rounded border border-border bg-surface-elevated px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted">
            OK
          </span>
        )
      }
      className={className}
      bodyClassName="space-y-3"
    >
      <div className="flex items-center justify-between text-sm">
        <span className="text-muted">Total</span>
        <span className="font-tabular text-sm font-semibold text-text-strong">{formatMb(totalMB)}</span>
      </div>
      <MetricBar
        label="Used"
        value={usedMB}
        max={totalMB}
        caption={`${formatMb(usedMB)} / ${formatMb(totalMB)}`}
      />
      {/* Free bar: constant accent. MetricBar's band colors treat high % as
          bad (usage), but for free memory high % is good. */}
      <div className="space-y-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-xs text-muted">Free</span>
          <span className="font-tabular text-sm text-text">{formatMb(freeMB)}</span>
        </div>
        <div className="h-1.5 overflow-hidden rounded-full bg-border">
          <div
            className="h-full rounded-full bg-accent transition-[width] duration-300 ease-out"
            style={{ width: `${freePct}%` }}
          />
        </div>
      </div>
      <div className="flex items-center justify-between text-sm">
        <span className="text-muted">Services used</span>
        <span className="font-tabular text-sm text-text">{formatMb(servicesUsedMB)}</span>
      </div>
      <div className="flex items-center justify-between text-sm">
        <span className="text-muted">Other used</span>
        <span className="font-tabular text-sm text-text">{formatMb(otherUsedMB)}</span>
      </div>
      {svcs.length > 0 && (
        <div className="space-y-1.5 border-t border-border pt-3">
          <div className="text-[10px] uppercase tracking-wide text-muted">Services</div>
          {svcs.map((s) => (
            <div key={s.name} className="flex items-center justify-between gap-2 text-xs">
              <div className="flex min-w-0 items-baseline gap-1.5">
                <span className="min-w-0 truncate text-text" title={s.name}>
                  {s.name}
                </span>
                <span className="shrink-0 text-muted">({s.kind})</span>
              </div>
              <span className="shrink-0 font-tabular text-text">
                {formatMb(s.footprintMB)}
                {s.running ? " · running" : ""}
                {s.needed ? " · needed" : ""}
              </span>
            </div>
          ))}
        </div>
      )}
      {plan.length > 0 && (
        <div className="space-y-1.5 border-t border-border pt-3">
          <div className="text-[10px] uppercase tracking-wide text-muted">Make-room plan</div>
          {plan.map((m) => (
            <div key={m.serviceName} className="flex items-center justify-between gap-2 text-xs">
              <span className="min-w-0 truncate text-text" title={m.reason}>
                {m.serviceName} <span className="text-muted">— {m.reason}</span>
              </span>
              <span className="shrink-0 font-tabular text-accent">+{formatMb(m.freesMB)}</span>
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}
