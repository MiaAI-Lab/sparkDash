import { useEffect, useRef, useState } from "react";
import {
  fetchDevEnginePlans,
  fetchDevEngineRunningTasks,
  fetchDevEngineSlotsConfig,
  fetchDevEngineStatus,
  fetchDevEngineTickets,
  fetchDevEngineWebuiUrl,
} from "../../api/client";
import type { EngineLive } from "../../shared/idleCounts";
import type {
  DevEnginePlan,
  DevEngineRunningTask,
  DevEngineSlotsConfig,
  DevEngineStatus,
  DevEngineTicket,
} from "../../api/types";
import { Panel } from "../ui/Panel";
import { BoltIcon, ExternalLinkIcon, GearIcon } from "../ui/icons";
import { SlotSettingsDialog } from "./SlotSettingsDialog";

const POLL_MS = 5000;

/** Ticket statuses that count as "active" for the panel. */
const ACTIVE_STATUSES: ReadonlySet<string> = new Set([
  "in_progress",
  "review",
  "queued",
  "failed",
]);

/** Plan statuses that count as "active". The engine already excludes completed
 *  plans from /api/plans; this keeps the section honest if a terminal status
 *  ever shows up. */
const ACTIVE_PLAN_STATUSES: ReadonlySet<string> = new Set([
  "queued",
  "processing",
  "creating_ticket",
  "failed",
]);

/** Task status colors matching the engine web UI (web-ui ActiveTaskItem/StatusBadge). */
const TASK_STATUS_COLOR: Record<string, string> = {
  pending: "#6b7280", // gray-500
  queued: "#6b7280",
  running: "#f59e0b", // amber-500
  fixing: "#8b5cf6", // violet-500
  in_progress: "#f59e0b",
  validating: "#d97706", // amber-600
  validation_fixing: "#ea580c", // orange-600
  reviewing: "#9333ea", // purple-600
  review: "#9333ea",
  done: "#16a34a", // green-600
  completed: "#16a34a",
  skipped: "#0d9488", // teal-600
  failed: "#dc2626", // red-600
  processing: "#0891b2", // cyan-600
  creating_ticket: "#4f46e5", // indigo-600
  cancelled: "#6b7280",
};

/** Human labels matching the engine web UI (StatusBadge LABEL map). */
const TASK_STATUS_LABEL: Record<string, string> = {
  pending: "Pending",
  queued: "Queued",
  running: "Running",
  fixing: "Fixing",
  in_progress: "In Progress",
  validating: "Validating",
  validation_fixing: "Val. Fixing",
  reviewing: "Reviewing",
  review: "Review",
  done: "Completed",
  completed: "Completed",
  skipped: "Skipped",
  failed: "Failed",
  processing: "Processing",
  creating_ticket: "Creating Ticket",
  cancelled: "Cancelled",
};

/** Ticket status colors matching the engine web UI (StatusBadge / Sidebar chips). */
const TICKET_STATUS_COLOR: Record<string, string> = {
  queued: "#6b7280", // gray-500
  in_progress: "#f59e0b", // amber-500
  review: "#9333ea", // purple-600
  completed: "#16a34a", // green-600
  failed: "#dc2626", // red-600
};

/** Ticket status labels matching the engine web UI. */
const TICKET_STATUS_LABEL: Record<string, string> = {
  queued: "Queued",
  in_progress: "In Progress",
  review: "Review",
  completed: "Completed",
  failed: "Failed",
};

/** Plan status colors matching the engine web UI (plan status badges). */
const PLAN_STATUS_COLOR: Record<string, string> = {
  queued: "#6b7280", // gray-500
  processing: "#0891b2", // cyan-600
  creating_ticket: "#4f46e5", // indigo-600
  completed: "#059669", // emerald-600
  failed: "#dc2626", // red-600
};

/** Plan status labels matching the engine web UI. */
const PLAN_STATUS_LABEL: Record<string, string> = {
  queued: "Queued",
  processing: "Processing",
  creating_ticket: "Creating Ticket",
  completed: "Completed",
  failed: "Failed",
};

/** Ticket id the engine mirrors a plan under — used for "open in engine" links. */
function planTicketId(planId: string): string {
  return planId.startsWith("PLAN-") ? planId : `PLAN-${planId}`;
}

/** Resolve the display tone for a ticket's PR badge. */
function prBadge(prUrl: string | null, prState: string): { text: string; cls: string } | null {
  if (!prUrl) return null;
  const state = prState || "unknown";
  if (state === "open") {
    return { text: "PR open", cls: "bg-success/15 text-success border-success/40" };
  }
  if (state === "merged") {
    return { text: "PR merged", cls: "bg-accent/15 text-accent border-accent/40" };
  }
  if (state === "closed") {
    return { text: "PR closed", cls: "bg-border/60 text-muted border-border" };
  }
  return { text: "PR", cls: "bg-accent/15 text-accent border-accent/40" };
}

function ageLabel(iso: string | null): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "—";
  const sec = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

function TicketRow({ ticket, onOpen }: { ticket: DevEngineTicket; onOpen: () => void }) {
  const badge = prBadge(ticket.pr_url, ticket.pr_state);
  const total = ticket.tasks_total;
  const done = ticket.tasks_done;
  const running = ticket.tasks_running;
  const fixing = ticket.tasks_fixing;
  const validating = ticket.tasks_validating;
  const valFixing = ticket.tasks_validation_fixing;
  const reviewing = ticket.tasks_reviewing;
  const failed = ticket.tasks_failed;
  const skipped = ticket.tasks_skipped ?? 0;
  const inFlight = running + fixing + validating + valFixing + reviewing;
  const pct = (n: number) => (total > 0 ? (n / total) * 100 : 0);
  const ticketColor = TICKET_STATUS_COLOR[ticket.status] ?? "var(--color-text)";
  const ticketLabel = TICKET_STATUS_LABEL[ticket.status] ?? ticket.status;

  return (
    <div className="flex items-center gap-2">
      <span
        className="h-1.5 w-1.5 shrink-0 rounded-full"
        style={{
          backgroundColor: ticketColor,
          boxShadow: `0 0 6px ${ticketColor}`,
        }}
        title={`${ticketLabel}${inFlight > 0 ? ` · ${inFlight} task(s) in flight` : ""}`}
      />
      <button
        type="button"
        onClick={onOpen}
        className="min-w-0 flex-1 text-left transition-colors hover:text-accent"
        title={`Open ${ticket.name} in the engine`}
      >
        <span className="flex min-w-0 items-baseline gap-1">
          <span className="block truncate text-xs text-text">{ticket.name}</span>
          <span className="shrink-0 font-tabular text-[10px] text-muted">
            #{ticket.ticket_id}
          </span>
        </span>
        {/* Multi-label status row — mirrors the engine's ticket card header */}
        <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-muted">
          <span className="font-tabular">{done}/{total} tasks</span>
          {running > 0 && <span className="text-[#fbbf24]">{running} running</span>}
          {fixing > 0 && <span className="text-[#a78bfa]">{fixing} fixing</span>}
          {reviewing > 0 && <span className="text-[#c084fc]">{reviewing} reviewing</span>}
          {validating > 0 && <span className="text-[#fbbf24]">{validating} validating</span>}
          {valFixing > 0 && <span className="text-[#ea580c]">{valFixing} val-fixing</span>}
          {failed > 0 && <span className="text-[#dc2626]">{failed} failed</span>}
          {skipped > 0 && <span className="text-[#14b8a6]">{skipped} skipped</span>}
          <span className="font-tabular">{ageLabel(ticket.created_at)}</span>
        </span>
        {/* Multi-color segmented progress bar — mirrors the engine web UI:
            green = done, amber (pulse) = running, amber = validating,
            violet = fixing, orange = val-fixing, purple (pulse) = reviewing,
            red = failed, teal = skipped, track = remaining. */}
        <span className="mt-1 flex h-1 w-full overflow-hidden rounded-full bg-border">
          {done > 0 && (
            <span className="h-full bg-[#22c55e]" style={{ width: `${pct(done)}%` }} />
          )}
          {running > 0 && (
            <span className="h-full animate-pulse bg-[#f59e0b]" style={{ width: `${pct(running)}%` }} />
          )}
          {fixing > 0 && (
            <span className="h-full animate-pulse bg-[#8b5cf6]" style={{ width: `${pct(fixing)}%` }} />
          )}
          {validating > 0 && (
            <span className="h-full animate-pulse bg-[#f59e0b]" style={{ width: `${pct(validating)}%` }} />
          )}
          {valFixing > 0 && (
            <span className="h-full animate-pulse bg-[#f97316]" style={{ width: `${pct(valFixing)}%` }} />
          )}
          {reviewing > 0 && (
            <span className="h-full animate-pulse bg-[#a855f7]" style={{ width: `${pct(reviewing)}%` }} />
          )}
          {failed > 0 && (
            <span className="h-full bg-[#ef4444]" style={{ width: `${pct(failed)}%` }} />
          )}
          {skipped > 0 && (
            <span className="h-full bg-[#14b8a6]" style={{ width: `${pct(skipped)}%` }} />
          )}
        </span>
      </button>
      {badge && (
        <a
          href={ticket.pr_url ?? undefined}
          target="_blank"
          rel="noreferrer"
          title={`Open PR ${ticket.pr_url}`}
          className={`shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-medium transition-colors hover:opacity-80 ${badge.cls}`}
        >
          {badge.text}
        </a>
      )}
    </div>
  );
}

/**
 * One active plan row. Plans have no task counters, so the row shows the plan
 * status, the ticket it refines/creates (when known), plan length and age.
 */
function PlanRow({ plan, onOpen }: { plan: DevEnginePlan; onOpen: () => void }) {
  const color = PLAN_STATUS_COLOR[plan.status] ?? "var(--color-text)";
  const label = PLAN_STATUS_LABEL[plan.status] ?? plan.status;
  const target = plan.target_ticket_id ?? plan.base_id;
  const busy = plan.status === "processing" || plan.status === "creating_ticket";
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full items-center gap-2 text-left transition-colors hover:text-accent"
      title={`Open plan ${plan.name} in the engine${plan.error_message ? ` — ${plan.error_message}` : ""}`}
    >
      <span
        className={`h-1.5 w-1.5 shrink-0 rounded-full ${busy ? "animate-pulse" : ""}`}
        style={{ backgroundColor: color, boxShadow: `0 0 6px ${color}` }}
        title={label}
      />
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-baseline gap-1">
          <span className="block truncate text-xs text-text">{plan.name}</span>
          {target && (
            <span className="shrink-0 font-tabular text-[10px] text-muted">#{target}</span>
          )}
        </span>
        <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-muted">
          <span style={{ color }}>{label}</span>
          {plan.iteration > 0 && <span className="font-tabular">iter {plan.iteration}</span>}
          {plan.content_length > 0 && (
            <span className="font-tabular">{(plan.content_length / 1000).toFixed(1)}k chars</span>
          )}
          <span className="font-tabular">{ageLabel(plan.created_at)}</span>
        </span>
      </span>
    </button>
  );
}

function RunningTaskRow({ task, onOpen }: { task: DevEngineRunningTask; onOpen: () => void }) {
  const color = TASK_STATUS_COLOR[task.status] ?? "var(--color-text)";
  const label = TASK_STATUS_LABEL[task.status] ?? task.status;
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full items-center gap-2 text-left transition-colors hover:text-accent"
      title={`${task.name} · ${label}`}
    >
      <span
        className="h-1.5 w-1.5 shrink-0 rounded-full"
        style={{ backgroundColor: color, boxShadow: `0 0 6px ${color}` }}
        title={label}
      />
      <span className="min-w-0 flex-1 truncate text-xs text-text" title={task.name}>
        {task.name}
      </span>
      <span className="shrink-0 font-tabular text-[10px] text-muted">
        {label} · {task.attempt}/{task.max_attempts}
      </span>
      <span className="shrink-0 font-tabular text-[10px] text-muted">
        {ageLabel(task.started_at)}
      </span>
    </button>
  );
}

/**
 * Compact "Spark Dev Engine" panel next to the AI Proxy panel. Shows scheduler
 * slot usage, currently-running tickets with progress, and pending PRs. The
 * whole row (or the header action) jumps to the engine's web UI.
 * Polls the bridge every POLL_MS. Offline/graceful when the engine is down.
 */
export function DevEnginePanel({
  onIdleCounts,
}: {
  /** Publish this poll's live idle counts so AutoPower can display them without re-querying. */
  onIdleCounts?: (counts: EngineLive) => void;
} = {}) {
  const [status, setStatus] = useState<DevEngineStatus | null>(null);
  const [tickets, setTickets] = useState<DevEngineTicket[]>([]);
  const [plans, setPlans] = useState<DevEnginePlan[]>([]);
  const [runningTasks, setRunningTasks] = useState<DevEngineRunningTask[]>([]);
  const [slots, setSlots] = useState<DevEngineSlotsConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [webuiUrl, setWebuiUrl] = useState<string | null>(null);
  const [slotsOpen, setSlotsOpen] = useState(false);
  // Kept in a ref: the poll loop runs in a deps-less effect.
  const idleRef = useRef(onIdleCounts);
  idleRef.current = onIdleCounts;

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function poll() {
      // Each endpoint degrades independently: a single upstream failure must
      // not clear the other panels' data, but total failure = engine down.
      const [s, t, p, r, sc] = await Promise.all([
        fetchDevEngineStatus().catch(() => null),
        fetchDevEngineTickets().catch(() => null),
        fetchDevEnginePlans().catch(() => null),
        fetchDevEngineRunningTasks().catch(() => null),
        fetchDevEngineSlotsConfig().catch(() => null),
      ]);
      if (cancelled) return;
      let saw = false;
      if (s) {
        saw = true;
        setStatus(s);
      }
      if (t) {
        saw = true;
        setTickets(t);
      }
      if (p) {
        saw = true;
        setPlans(p);
      }
      if (r) {
        saw = true;
        setRunningTasks(r);
      }
      if (sc) {
        saw = true;
        setSlots(sc);
      }
      setError(saw ? null : "Dev engine unreachable — no data");
      // Publish for AutoPower. plansActive uses the DECISION definition
      // (queued/processing/creating_ticket) — a failed plan is terminal, so it
      // is listed in this panel but must not read as busy to AutoPower.
      idleRef.current?.({
        ok: s != null && p != null,
        slotsUsed: s?.slots_used ?? 0,
        ticketsActive: s?.tickets_active ?? 0,
        plansActive: (p ?? []).filter((pl) => pl.status === "queued" || pl.status === "processing" || pl.status === "creating_ticket").length,
        at: Date.now(),
      });
      if (!cancelled) timer = setTimeout(poll, POLL_MS);
    }

    void fetchDevEngineWebuiUrl()
      .then((r) => {
        if (!cancelled) setWebuiUrl(r.url);
      })
      .catch(() => {});

    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  const online = !error;
  const activeTickets = (tickets ?? []).filter((t) => ACTIVE_STATUSES.has(t.status));
  const activePlans = (plans ?? []).filter((p) => ACTIVE_PLAN_STATUSES.has(p.status));
  const withPendingPrs = (tickets ?? []).filter(
    (t) => t.pr_url && (t.pr_state === "open" || t.pr_state === "unknown")
  );
  const slotsUsed = status?.slots_used ?? slots?.effective_concurrency ?? 0;
  const slotsTotal = status?.slots_total ?? slots?.effective_concurrency ?? 0;
  const slotPct = slotsTotal > 0 ? Math.round((slotsUsed / slotsTotal) * 100) : 0;

  return (
    <Panel
      title="Spark Dev Engine"
      icon={
        <span
          className={`h-2 w-2 shrink-0 rounded-full ${
            online ? "bg-success dot-glow-success" : "bg-danger dot-glow-danger"
          }`}
          title={online ? "Engine online" : "Engine unreachable"}
        />
      }
      accent
      className="flex flex-col"
      bodyClassName="flex flex-1 flex-col space-y-3"
      actions={
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => setSlotsOpen(true)}
            title="Edit slot settings (day/night concurrency)"
            className="inline-flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[11px] text-muted transition-colors hover:border-accent hover:text-accent"
          >
            <GearIcon className="h-3 w-3" />
            Slots
          </button>
          <a
            href={webuiUrl ?? undefined}
            target="_blank"
            rel="noreferrer"
            title="Open the Spark Dev Engine web UI"
            className="inline-flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[11px] text-muted transition-colors hover:border-accent hover:text-accent"
          >
            <ExternalLinkIcon className="h-3 w-3" />
            Open engine
          </a>
        </div>
      }
    >
      {error ? (
        <div className="space-y-1">
          <p className="text-xs text-warning">Dev engine unreachable</p>
          <p className="break-all text-[11px] text-muted">{error}</p>
        </div>
      ) : (
        <>
          {/* Running tasks */}
          <div className="min-h-[6rem] space-y-1">
            <p className="text-xs uppercase tracking-wide text-muted">
              Running tasks ({runningTasks.length})
            </p>
            {runningTasks.length > 0 ? (
              runningTasks.map((task) => (
                <RunningTaskRow
                  key={`${task.ticket_id}-${task.task_id}-${task.iteration}`}
                  task={task}
                  onOpen={() => {
                    if (webuiUrl) {
                      window.open(
                        `${webuiUrl}/tickets/${task.ticket_id}?task=${encodeURIComponent(task.task_id)}&taskIteration=${task.iteration}`,
                        "_blank",
                        "noreferrer"
                      );
                    }
                  }}
                />
              ))
            ) : (
              <p className="text-xs text-muted">No tasks currently running.</p>
            )}
          </div>

          {/* Active plans */}
          <div className="space-y-1">
            <p className="text-xs uppercase tracking-wide text-muted">
              Active plans ({activePlans.length})
            </p>
            {activePlans.length > 0 ? (
              activePlans.map((plan) => (
                <PlanRow
                  key={plan.plan_id}
                  plan={plan}
                  onOpen={() => {
                    if (webuiUrl) {
                      window.open(
                        `${webuiUrl}/tickets/${encodeURIComponent(planTicketId(plan.plan_id))}`,
                        "_blank",
                        "noreferrer"
                      );
                    }
                  }}
                />
              ))
            ) : (
              <p className="text-xs text-muted">No active plans.</p>
            )}
          </div>

          {/* Active tickets */}
          <div className="space-y-1">
            <p className="text-xs uppercase tracking-wide text-muted">
              Active tickets ({activeTickets.length})
            </p>
            {activeTickets.length > 0 ? (
              activeTickets.map((ticket) => (
                <TicketRow
                  key={ticket.ticket_id}
                  ticket={ticket}
                  onOpen={() => {
                    if (webuiUrl) {
                      window.open(
                        `${webuiUrl}/tickets/${ticket.ticket_id}`,
                        "_blank",
                        "noreferrer"
                      );
                    }
                  }}
                />
              ))
            ) : (
              <p className="text-xs text-muted">No active tickets.</p>
            )}
          </div>

          {/* Pending PRs */}
          <div className="space-y-1">
            <p className="text-xs uppercase tracking-wide text-muted">
              Pending PRs ({withPendingPrs.length})
            </p>
            {withPendingPrs.length > 0 ? (
              withPendingPrs.map((ticket) => (
                <div key={`pr-${ticket.ticket_id}`} className="flex items-center gap-2">
                  <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-indigo-400" />
                  <span className="min-w-0 flex-1 truncate text-xs text-text">
                    {ticket.name}
                  </span>
                  <a
                    href={ticket.pr_url ?? undefined}
                    target="_blank"
                    rel="noreferrer"
                    className="shrink-0 inline-flex items-center gap-1 rounded border border-indigo-500/40 px-1.5 py-0.5 text-[10px] font-medium text-indigo-400 transition-colors hover:border-indigo-500"
                    title={ticket.pr_url ?? ""}
                  >
                    PR
                    <ExternalLinkIcon className="h-2.5 w-2.5" />
                  </a>
                </div>
              ))
            ) : (
              <p className="text-xs text-muted">No pending pull requests.</p>
            )}
          </div>
        </>
      )}

      {/* Slot usage footer */}
      <div className="mt-auto flex items-center gap-3 border-t border-border pt-3">
        <div className="min-w-0 flex-1">
          <div className="h-1.5 overflow-hidden rounded-full bg-border">
            <div
              className="h-full rounded-full bg-bar"
              style={{ width: `${slotPct}%` }}
            />
          </div>
        </div>
        <span className="shrink-0 whitespace-nowrap text-center" title="Slots in use">
          <span className="font-tabular text-[18px] font-bold leading-none text-text-strong">
            {online ? `${slotsUsed} / ${slotsTotal}` : "— / —"}
          </span>
          <span className="text-sm font-normal text-muted"> slots</span>
        </span>
      </div>
      <SlotSettingsDialog
        open={slotsOpen}
        onClose={() => setSlotsOpen(false)}
        onSaved={(next) => {
          setSlots(next);
          // Re-poll so status totals reflect the new concurrency promptly.
          void fetchDevEngineStatus().then((s) => setStatus(s)).catch(() => {});
        }}
      />
    </Panel>
  );
}
