import { useState, useCallback, type MouseEvent } from "react";
import type { ComfyJob, ComfyMetrics, ComfyProgress } from "../../api/types";
import { cancelComfyJob } from "../../api/client";
import { Panel } from "../ui/Panel";
import { ComfyIcon, ExternalLinkIcon } from "../ui/icons";

interface ComfyPanelProps {
  comfy: ComfyMetrics | null;
  comfyPort: number;
  sparkId: string;
  /** Spark LAN IP — preferred host for the Open ComfyUI deep link. */
  lanIp?: string | null;
  className?: string;
}

/** Browser URL for ComfyUI UI — always LAN IP when known (never dashboard origin). */
function comfyOpenUrl(lanIp: string | null | undefined, comfyPort: number, serverOpenUrl?: string | null): string {
  const port =
    Number.isInteger(comfyPort) && comfyPort >= 1 && comfyPort <= 65535 ? comfyPort : 8188;
  const lan = lanIp != null ? String(lanIp).trim() : "";
  if (lan && lan !== "127.0.0.1" && lan !== "localhost") {
    return `http://${lan}:${port}`;
  }
  // Prefer server-provided URL if it is absolute and not the dashboard path
  if (serverOpenUrl && /^https?:\/\//i.test(serverOpenUrl)) {
    try {
      const u = new URL(serverOpenUrl);
      if (u.port !== "5555" && !u.pathname.startsWith("/spark")) {
        return serverOpenUrl;
      }
      // If server sent a loopback URL, still use host when non-local path
      if (u.hostname !== "127.0.0.1" && u.hostname !== "localhost") {
        return `http://${u.hostname}:${port}`;
      }
    } catch {
      /* fall through */
    }
  }
  return `http://127.0.0.1:${port}`;
}

function shortId(id: string): string {
  if (id.length <= 12) return id;
  return `${id.slice(0, 8)}…`;
}

function formatElapsed(createTimeMs: number | null | undefined): string | null {
  if (createTimeMs == null || !Number.isFinite(createTimeMs)) return null;
  const ms = createTimeMs < 1e12 ? createTimeMs * 1000 : createTimeMs;
  const elapsedSec = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (elapsedSec < 60) return `${elapsedSec}s`;
  const m = Math.floor(elapsedSec / 60);
  const s = elapsedSec % 60;
  if (m < 60) return `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function formatDurationMs(ms: number | null | undefined): string | null {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return null;
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m < 60) return s ? `${m}m ${s}s` : `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function formatEtaMs(ms: number | null | undefined): string | null {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return null;
  return `~${formatDurationMs(ms)}`;
}

function jobFootprint(job: ComfyJob): string {
  const parts: string[] = [];
  if (job.width != null && job.height != null) {
    parts.push(`${job.width}×${job.height}`);
  }
  if (job.steps != null) parts.push(`${job.steps} steps`);
  if (job.batchSize != null && job.batchSize !== 1) parts.push(`batch ${job.batchSize}`);
  if (job.sampler) parts.push(job.sampler);
  if (job.nodeCount > 0) parts.push(`${job.nodeCount} nodes`);
  return parts.join(" · ");
}

function ProgressBar({ progress }: { progress: ComfyProgress }) {
  const pct =
    progress.percent != null
      ? progress.percent
      : progress.max > 0
        ? Math.min(100, Math.round((progress.value / progress.max) * 100))
        : 0;
  const label =
    progress.nodeLabel ||
    (progress.source === "estimate" ? "Elapsed (est.)" : "Progress");
  const detail =
    progress.max > 0 && progress.source === "ws"
      ? `${Math.round(progress.value)}/${Math.round(progress.max)}`
      : progress.percent != null
        ? `${pct}%`
        : null;

  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-2 text-[11px]">
        <span className="truncate text-muted" title={label}>
          {label}
          {progress.source === "estimate" ? (
            <span className="ml-1 text-[10px] opacity-70">est.</span>
          ) : null}
        </span>
        {detail ? <span className="font-tabular text-text">{detail}</span> : null}
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-border">
        <div
          className="h-full rounded-full bg-accent transition-[width] duration-300"
          style={{ width: `${Math.min(100, Math.max(0, pct))}%` }}
        />
      </div>
    </div>
  );
}

function JobBlock({
  job,
  variant,
  progress,
  etaLabel,
  onCancel,
  cancelling,
}: {
  job: ComfyJob;
  variant: "running" | "pending";
  progress?: ComfyProgress | null;
  etaLabel?: string | null;
  onCancel?: () => void;
  cancelling?: boolean;
}) {
  const title = job.title?.trim() || shortId(job.id);
  const footprint = jobFootprint(job);
  const elapsed = variant === "running" ? formatElapsed(job.createTime) : null;
  const models = job.models ?? [];

  return (
    <div className="space-y-2 rounded-md border border-border bg-surface-elevated/40 px-3 py-2.5">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`llm-badge ${variant === "running" ? "" : "opacity-80"}`}
              title={job.id}
            >
              <span
                className={`h-1.5 w-1.5 rounded-full ${
                  variant === "running" ? "bg-accent" : "bg-muted"
                }`}
              />
              {variant === "running" ? "Running" : "Queued"}
            </span>
            {elapsed ? (
              <span className="font-tabular text-[11px] text-muted">{elapsed}</span>
            ) : null}
            {etaLabel ? (
              <span className="font-tabular text-[11px] text-muted" title="Estimated time remaining">
                {etaLabel} left
              </span>
            ) : null}
          </div>
          <p className="mt-1 truncate text-sm font-medium text-text" title={job.title || job.id}>
            {title}
          </p>
        </div>
        {onCancel ? (
          <button
            type="button"
            onClick={onCancel}
            disabled={cancelling}
            className="shrink-0 rounded border border-border px-2 py-0.5 text-[11px] text-muted transition-colors hover:border-danger hover:text-danger disabled:opacity-50"
          >
            {cancelling ? "…" : variant === "running" ? "Cancel" : "Remove"}
          </button>
        ) : null}
      </div>

      {variant === "running" && progress ? <ProgressBar progress={progress} /> : null}

      {footprint ? (
        <p className="font-tabular text-[11px] text-muted" title="Workflow compute footprint">
          {footprint}
        </p>
      ) : null}

      {models.length > 0 ? (
        <div className="space-y-1">
          <div className="text-[10px] uppercase tracking-wide text-muted">Models</div>
          <ul className="space-y-0.5">
            {models.slice(0, 6).map((m) => (
              <li key={m} className="truncate font-tabular text-[12px] text-text" title={m}>
                {m}
              </li>
            ))}
            {models.length > 6 ? (
              <li className="text-[11px] text-muted">+{models.length - 6} more</li>
            ) : null}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

export function ComfyPanel({
  comfy,
  comfyPort,
  sparkId,
  lanIp,
  className = "",
}: ComfyPanelProps) {
  const available = Boolean(comfy?.available);
  const pending = comfy?.queuePending ?? 0;
  const active = comfy?.activeJob ?? null;
  const pendingJobs = comfy?.pendingJobs ?? [];
  const progress = comfy?.progress ?? null;
  const lastJob = comfy?.lastJob ?? null;
  const modelsInstalled = comfy?.modelsInstalled ?? null;
  const etaLabel = formatEtaMs(comfy?.queueEtaMs ?? null);
  const openUrl = comfyOpenUrl(lanIp, comfyPort, comfy?.openUrl ?? null);

  const [cancellingId, setCancellingId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [modelsOpen, setModelsOpen] = useState(false);

  const handleOpenComfy = useCallback(
    (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      // Force a real top-level navigation off the sparkDash SPA origin.
      window.open(openUrl, "_blank", "noopener,noreferrer");
    },
    [openUrl]
  );

  const handleCancel = useCallback(
    async (promptId: string) => {
      if (!confirm("Cancel this ComfyUI job?")) return;
      setActionError(null);
      setCancellingId(promptId);
      try {
        await cancelComfyJob(sparkId, promptId);
      } catch (err) {
        setActionError(err instanceof Error ? err.message : String(err));
      } finally {
        setCancellingId(null);
      }
    },
    [sparkId]
  );

  return (
    <Panel
      title="ComfyUI"
      icon={<ComfyIcon />}
      className={`panel-comfy ${className}`}
      bodyClassName="space-y-3"
      accent
      actions={
        <div className="flex items-center gap-2">
          <span className="font-tabular text-[11px] text-muted" title="Probe port">
            :{comfyPort}
          </span>
          <a
            href={openUrl}
            target="_blank"
            rel="noopener noreferrer"
            onClick={handleOpenComfy}
            title={`Open ComfyUI at ${openUrl} (must be reachable from your browser)`}
            className="inline-flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[11px] text-muted transition-colors hover:border-accent hover:text-accent"
          >
            <ExternalLinkIcon className="h-3 w-3" />
            Open
          </a>
        </div>
      }
    >
      {!available ? (
        <div className="space-y-1 text-sm">
          <p className="text-muted">Not reachable</p>
          {comfy?.error ? (
            <p className="break-all text-[11px] text-muted">{comfy.error}</p>
          ) : (
            <p className="text-[11px] text-muted">
              Ensure ComfyUI is running on this host (default port 8188).
            </p>
          )}
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="llm-badge">
              <span className="h-1.5 w-1.5 rounded-full bg-accent" />
              Online
            </span>
            {comfy?.version ? (
              <span className="text-muted" title="ComfyUI version">
                v{comfy.version}
              </span>
            ) : null}
            {comfy?.deviceType ? (
              <span className="text-muted" title="ComfyUI compute device">
                {comfy.deviceType}
              </span>
            ) : null}
            {comfy?.pytorchVersion ? (
              <span className="text-muted" title="PyTorch version">
                torch {comfy.pytorchVersion}
              </span>
            ) : null}
          </div>

          {actionError ? (
            <p className="text-[11px] text-danger">{actionError}</p>
          ) : null}

          {active ? (
            <JobBlock
              job={active}
              variant="running"
              progress={progress}
              etaLabel={etaLabel}
              onCancel={() => void handleCancel(active.id)}
              cancelling={cancellingId === active.id}
            />
          ) : (
            <div className="space-y-2">
              <div className="rounded-md border border-dashed border-border px-3 py-3 text-sm text-muted">
                Idle — no running job
              </div>
              {lastJob ? (
                <p
                  className={`text-[11px] ${
                    lastJob.status === "failed"
                      ? "text-danger"
                      : lastJob.status === "cancelled"
                        ? "text-muted"
                        : "text-muted"
                  }`}
                >
                  Last:{" "}
                  <span className="text-text">
                    {lastJob.title?.trim() || shortId(lastJob.id)}
                  </span>
                  {formatDurationMs(lastJob.durationMs)
                    ? ` · ${formatDurationMs(lastJob.durationMs)}`
                    : ""}
                  {` · ${lastJob.status}`}
                </p>
              ) : null}
            </div>
          )}

          {pending > 0 ? (
            <div className="space-y-2">
              <div className="flex items-baseline justify-between gap-2 text-[10px] uppercase tracking-wide text-muted">
                <span>Queue</span>
                <span className="font-tabular normal-case text-muted">
                  {pending} pending
                  {etaLabel ? ` · ${etaLabel}` : ""}
                </span>
              </div>
              {pendingJobs.slice(0, 2).map((job) => (
                <JobBlock
                  key={job.id}
                  job={job}
                  variant="pending"
                  onCancel={() => void handleCancel(job.id)}
                  cancelling={cancellingId === job.id}
                />
              ))}
              {pending > Math.min(2, pendingJobs.length) ? (
                <p className="text-[11px] text-muted">
                  +{pending - Math.min(2, pendingJobs.length)} more waiting
                </p>
              ) : null}
            </div>
          ) : null}

          {active && lastJob ? (
            <p className="text-[11px] text-muted">
              Last: {lastJob.title?.trim() || shortId(lastJob.id)}
              {formatDurationMs(lastJob.durationMs)
                ? ` · ${formatDurationMs(lastJob.durationMs)}`
                : ""}
              {` · ${lastJob.status}`}
            </p>
          ) : null}

          {modelsInstalled &&
          (modelsInstalled.checkpoints.length > 0 || modelsInstalled.loras.length > 0) ? (
            <div className="border-t border-border pt-2">
              <button
                type="button"
                onClick={() => setModelsOpen((o) => !o)}
                className="flex w-full items-center justify-between text-left text-[11px] text-muted hover:text-text"
              >
                <span>
                  Installed: {modelsInstalled.checkpoints.length} checkpoints ·{" "}
                  {modelsInstalled.loras.length} loras
                </span>
                <span className="text-[10px]">{modelsOpen ? "Hide" : "Show"}</span>
              </button>
              {modelsOpen ? (
                <div className="mt-1.5 grid gap-2 sm:grid-cols-2">
                  {modelsInstalled.checkpoints.length > 0 ? (
                    <div>
                      <div className="text-[10px] uppercase tracking-wide text-muted">
                        Checkpoints
                      </div>
                      <ul className="mt-0.5 space-y-0.5">
                        {modelsInstalled.checkpoints.slice(0, 12).map((m) => (
                          <li
                            key={m}
                            className="truncate font-tabular text-[11px] text-text"
                            title={m}
                          >
                            {m}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                  {modelsInstalled.loras.length > 0 ? (
                    <div>
                      <div className="text-[10px] uppercase tracking-wide text-muted">LoRAs</div>
                      <ul className="mt-0.5 space-y-0.5">
                        {modelsInstalled.loras.slice(0, 12).map((m) => (
                          <li
                            key={m}
                            className="truncate font-tabular text-[11px] text-text"
                            title={m}
                          >
                            {m}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}
        </>
      )}
    </Panel>
  );
}
