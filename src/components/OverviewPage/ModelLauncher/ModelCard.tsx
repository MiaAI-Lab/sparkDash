import { useState } from "react";
import type { ModelInfo } from "../../../api/modelTypes";
import { restartModel, startModel, stopModel, tailModelLogs } from "../../../api/modelClient";
import { openModelCommandDialog } from "../../../hooks/useModelCommandDialog";
import { openModelScheduleDialog } from "../../../hooks/useModelScheduleDialog";
import { openModelEditDialog } from "../../../hooks/useModelEditDialog";
import {
  CalendarIcon,
  GearIcon,
  GithubIcon,
  GripIcon,
  LogsIcon,
  PowerOffIcon,
  PowerOnIcon,
  RotateIcon,
} from "../../ui/icons";

interface ModelCardProps {
  model: ModelInfo;
  /** A mutating job is in flight (mine or another model's) — lock the actions. */
  busy: boolean;
  /** This card's own action is the one in flight (spinner, not just disabled). */
  busyHere: boolean;
  /** Scheduler says this model is the one that *should* be running now. */
  scheduledNow: boolean;
  /** This card is the one currently being dragged (render dimmed). */
  dragging: boolean;
  /** Another card is being hovered over this slot (render the accent ring). */
  dragOver: boolean;
  onCardDragStart: (id: string) => void;
  onCardDragEnter: (id: string) => void;
  /** The card was dropped on — panel commits the currently previewed order. */
  onCardDrop: () => void;
  onCardDragEnd: () => void;
  onActionStarted?: () => void;
}

/**
 * One repo = one card. The Start/Stop control is a single colour-swapped
 * toggle cloned from SparkActions' Shutdown/Wake pair — same geometry
 * (`rounded-md border px-3 py-1.5 text-[11px]`), and the fill flips
 * `bg-accent` (idle → click to start) ⇄ `bg-danger` (running → click to stop)
 * so the state and the affordance are the same colour, exactly like the power
 * buttons on a Spark.
 *
 * The last transcript remains reachable through the clickable job chip at the
 * bottom of the card.
 */
export function ModelCard({
  model,
  busy,
  busyHere,
  scheduledNow,
  dragging,
  dragOver,
  onCardDragStart,
  onCardDragEnter,
  onCardDrop,
  onCardDragEnd,
  onActionStarted,
}: ModelCardProps) {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);

  const running = model.status.running;
  const disabled = busy;

  async function run(kind: "start" | "stop" | "restart") {
    setPending(kind);
    setError(null);
    try {
      const fn =
        kind === "start"
          ? startModel
          : kind === "stop"
            ? stopModel
              : restartModel;
      const res = await fn(model.id);
      openModelCommandDialog({
        jobId: res.jobId,
        modelId: model.id,
        modelName: model.name,
        action: kind,
        stopping: res.stopping,
      });
      onActionStarted?.();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : `${kind} failed`);
      setTimeout(() => setError(null), 8000);
    } finally {
      setPending(null);
    }
  }

  // Tail a running container's logs in the transcript modal. Read-only job —
  // it does not take the single mutating slot, so it isn't gated by `busy`.
  async function runLogs() {
    setError(null);
    try {
      const res = await tailModelLogs(model.id);
      openModelCommandDialog({
        jobId: res.jobId,
        modelId: model.id,
        modelName: model.name,
        action: "logs",
      });
      onActionStarted?.();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "logs failed");
      setTimeout(() => setError(null), 8000);
    }
  }

  const jobRunning = model.job?.status === "running";

  // The job chip is an error affordance only: show it when the newest job
  // actually failed — errored, timed out, or exited non-zero. A hand-cancel
  // (which is normal: closing a start tail, a redeploy) is not an error.
  const jobFailed =
    model.job != null &&
    (model.job.status === "error" ||
      model.job.timedOut === true ||
      (model.job.status === "done" && typeof model.job.exitCode === "number" && model.job.exitCode !== 0));

  // Probe confidence: "down" is only certain when at least one signal said no.
  const downCertain = model.status.containerUp === false || model.status.portUp === false;

  // Brief one-line view of this model's enabled windows, e.g.
  // "weekday 18:00–08:00 · weekend 00:00–23:59" — no "sched" prefix, the card
  // already shows the schedule badge; models without an enabled schedule
  // render nothing.
  const schedLine = (() => {
    const s = model.schedule;
    if (!s?.enabled) return null;
    const fmt = (ws: { start: string; end: string }[]) =>
      ws.map((w) => (w.start === w.end ? "all day" : `${w.start}–${w.end}`)).join(", ");
    const parts: string[] = [];
    if (s.weekday?.length) parts.push(`weekday ${fmt(s.weekday)}`);
    if (s.weekend?.length) parts.push(`weekend ${fmt(s.weekend)}`);
    return parts.length ? parts.join(" · ") : "no windows yet";
  })();

  return (
    <article
      draggable
      title="Drag this card onto another to reorder the list"
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", model.id);
        onCardDragStart(model.id);
      }}
      onDragOver={(e) => {
        // preventDefault marks this card a valid drop target — for EVERY card
        // including the dragged one: once the preview swap slides the dragged
        // card under the cursor, self-hover must still accept (and keep) the
        // pending order instead of cancelling the drop.
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        onCardDragEnter(model.id);
      }}
      onDrop={(e) => {
        e.preventDefault();
        onCardDrop();
      }}
      onDragEnd={onCardDragEnd}
      className={`overview-card flex flex-col transition-opacity ${
        dragging ? "opacity-40" : ""
      } ${dragOver ? "ring-1 ring-accent" : ""}`}
      style={{ padding: "var(--density-card-pad)", gap: "var(--density-card-gap)" }}
    >
      {/* Header: grip + state dot + name + badges */}
      <div className="flex items-center gap-2.5">
        <GripIcon className="h-3 w-3 shrink-0 text-muted opacity-30 transition-opacity hover:opacity-70" />
        <span
          className={`h-2 w-2 shrink-0 rounded-full ${
            running ? "bg-success dot-glow-success" : downCertain ? "bg-danger" : "bg-muted"
          }`}
          title={
            running
              ? "Running"
              : model.status.error
                ? `Not detected — ${model.status.error}`
                : "Not running"
          }
        />
        <span
          className="min-w-0 flex-1 truncate text-[15px] font-semibold text-text-strong"
          title={`${model.name} — ${model.dir}`}
        >
          {model.name}
        </span>
        {scheduledNow && (
          <span
            className="shrink-0 rounded bg-accent/15 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-accent"
            title="The scheduler wants this model up in the current window"
          >
            scheduled
          </span>
        )}
        {model.schedule.enabled && !scheduledNow && (
          <span
            className="shrink-0 rounded bg-border/60 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted"
            title="This model has an enabled schedule, but another window is active now"
          >
            on call
          </span>
        )}
        <span className="shrink-0 text-[10px] uppercase tracking-wide text-muted">
          {running ? "running" : "stopped"}
        </span>
      </div>

      {/* Probe targets: container + port, one line. The repo path is dropped
          from the chips (it lives in the name tooltip); start args stay out of
          the card too — the job transcript already echoes them. */}
      <div className="space-y-1">
        {(model.description || model.repoUrl) && (
          <div className="flex items-start gap-1.5">
            {model.description && (
              <p className="line-clamp-2 flex-1 text-[11px] leading-snug text-muted">
                {model.description}
              </p>
            )}
            {model.repoUrl && (
              <a
                href={model.repoUrl}
                target="_blank"
                rel="noreferrer"
                onDragStart={(e) => e.preventDefault()}
                className="shrink-0 text-muted transition-colors hover:text-text"
                title={model.repoUrl}
              >
                <GithubIcon className="h-3.5 w-3.5" />
              </a>
            )}
          </div>
        )}
        <div className="flex flex-wrap items-center gap-1.5 text-[10px] text-muted">
          {model.sparkId ? (
            <span
              className="rounded bg-border/60 px-1.5 py-0.5 font-tabular"
              title={`scripts and probes run over SSH on ${model.sparkName} (${model.sparkId})`}
            >
              ⇄ {model.sparkName}
            </span>
          ) : (
            <span
              className="rounded bg-danger/15 px-1.5 py-0.5 font-tabular text-danger"
              title="No Spark assigned — actions refuse until the card names the machine where its scripts live"
            >
              no spark
            </span>
          )}
          {model.container && (
            <span
              className={`rounded px-1.5 py-0.5 font-tabular ${
                model.status.containerUp === true
                  ? "bg-success/15 text-success"
                  : model.status.containerUp === false
                    ? "bg-border/60 text-muted"
                    : "bg-border/60 text-muted"
              }`}
              title={`container ${model.container}: ${
                model.status.containerUp == null ? "unknown (docker check unavailable)" : model.status.containerUp ? "up" : "down"
              }`}
            >
              ⬢ {model.container}
            </span>
          )}
          {model.port && (
            <span
              className={`rounded px-1.5 py-0.5 font-tabular ${
                model.status.portUp === true
                  ? "bg-success/15 text-success"
                  : "bg-border/60 text-muted"
              }`}
              title={`:${model.port}/v1/models on ${model.sparkName || "the dashboard host"}: ${
                model.status.portChecked === false
                  ? model.status.portUp
                    ? "held by this model's container (not probed)"
                    : "held elsewhere (not probed)"
                  : model.status.portUp
                    ? "answering"
                    : "not answering"
              }`}
            >
              :{model.port}
            </span>
          )}
          {model.hasLogs && model.status.containerUp === true && (
            <button
              type="button"
              onClick={() => void runLogs()}
              onDragStart={(e) => e.preventDefault()}
              className="flex items-center gap-1 rounded px-1.5 py-0.5 font-tabular text-muted transition-colors hover:bg-surface-hover hover:text-accent"
              title="Tail this container's logs"
            >
              <LogsIcon className="h-3 w-3" /> logs
            </button>
          )}
        </div>
      </div>

      {/* Error line (validation / action failure). The steady-state probe
          error (e.g. ":8000 held by another model") is NOT shown — the dot
          tooltip and the :8000 chip colour already carry that; this line is
          instead a muted summary of the model's active schedule windows. */}
      {error && <p className="break-words text-[11px] text-danger">{error}</p>}
      {!error && schedLine && (
        <div className="flex items-center gap-1.5 text-[11px] text-muted">
          <CalendarIcon className="h-3 w-3 shrink-0 opacity-70" />
          <span className="min-w-0 flex-1 truncate" title={schedLine}>
            {schedLine}
          </span>
        </div>
      )}

      {/* Job chip — surfaced ONLY when the last job failed, so a healthy or
          merely-running model never shows it. A transcript is the way to see
          WHY it failed, so the chip opens it and the tooltip carries the error
          line. Healthy/completed/cancelled-by-hand jobs are silent — their
          state is already visible via the status dot and the logs link. */}
      {model.job && jobFailed && (
        <button
          type="button"
          onClick={() =>
            openModelCommandDialog({
              jobId: model.job!.jobId,
              modelId: model.id,
              modelName: model.name,
              action: model.job!.action,
            })
          }
          className="flex min-w-0 items-center gap-1.5 self-start text-[10px] text-danger transition-colors hover:text-danger/80"
          title={`${model.job.error || `${model.job.action} ${model.job.status}`}${
            typeof model.job.exitCode === "number" ? ` (exit ${model.job.exitCode})` : ""
          } — open transcript`}
        >
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-danger" />
          <span className="truncate font-tabular">
            {model.job.action} failed
            {typeof model.job.exitCode === "number" ? ` · exit ${model.job.exitCode}` : ""}
          </span>
        </button>
      )}

      {/* Actions — starting a drag from a button must not drag the card. */}
      <div
        className="mt-auto flex flex-wrap items-center gap-1.5 pt-1"
        onDragStart={(e) => e.preventDefault()}
      >
        {/* Colour-swapped power toggle (SparkActions geometry) */}
        <button
          type="button"
          onClick={() => void run(running ? "stop" : "start")}
          disabled={disabled}
          title={
            running
              ? `Run ./${model.name} stop.sh on the host`
              : `Run ./${model.name} start.sh on the host (stops any other running model first)`
          }
          className={`flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-[11px] font-medium text-white transition-colors disabled:opacity-50 ${
            running ? "border-danger bg-danger hover:bg-danger/80" : "border-accent bg-accent hover:bg-accent-hover"
          }`}
        >
          {pending === (running ? "stop" : "start") || (busyHere && jobRunning) ? (
            <RotateIcon className="h-3 w-3 animate-spin" />
          ) : running ? (
            <PowerOffIcon className="h-3 w-3" />
          ) : (
            <PowerOnIcon className="h-3 w-3" />
          )}
          {running ? "Stop" : "Start"}
        </button>

        <button
          type="button"
          onClick={() => void run("restart")}
          disabled={disabled || !model.canRestart}
          title={
            model.canRestart
              ? "Run the repo's restart.sh on the host"
              : "No restart script configured for this repo"
          }
          className="flex items-center gap-1.5 rounded-md border border-border bg-surface-elevated px-3 py-1.5 text-[11px] text-muted transition-colors hover:bg-surface-hover hover:text-text disabled:opacity-50"
        >
          {pending === "restart" ? <RotateIcon className="h-3 w-3 animate-spin" /> : <RotateIcon className="h-3 w-3" />}
          Restart
        </button>

        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={() => openModelScheduleDialog(model.id)}
            className={`flex items-center gap-1 rounded-md border px-2 py-1.5 text-[11px] transition-colors ${
              model.schedule.enabled
                ? "border-accent/40 text-accent hover:bg-accent/10"
                : "border-border bg-surface-elevated text-muted hover:bg-surface-hover hover:text-text"
            }`}
            title="Schedule this model's running windows"
          >
            <GearIcon className="h-3 w-3" />
            Schedule
          </button>
          <button
            type="button"
            onClick={() => openModelEditDialog(model.id)}
            className="flex items-center gap-1 rounded-md border border-border bg-surface-elevated px-2 py-1.5 text-[11px] text-muted transition-colors hover:bg-surface-hover hover:text-text"
            title="Edit this model's scripts / container / port"
          >
            <GearIcon className="h-3 w-3" />
          </button>
        </div>
      </div>

    </article>
  );
}
