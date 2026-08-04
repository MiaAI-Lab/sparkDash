import { useState } from "react";
import type { ComfyMetrics } from "../../api/types";
import { updateSpark, updateVideoPorts } from "../../api/client";
import { Panel } from "../ui/Panel";
import { FilmIcon, GearIcon } from "../ui/icons";

interface ComfyPanelProps {
  comfy: ComfyMetrics | null;
  sparkId: string;
  videoPort: number;
  /** All configured video ports — needed to rewrite the list when the port changes. */
  videoPorts: number[];
  comfyLogPath?: string | null;
  onPortsChange?: (ports: number[]) => void;
  onRemovePort?: (port: number) => void;
  className?: string;
}

const GIB = 1024 ** 3;

/** "1:23" / "1:04:12" */
function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return "—";
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

function formatGiB(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes)) return "—";
  return `${(bytes / GIB).toFixed(1)} GiB`;
}

export function ComfyPanel({
  comfy,
  sparkId,
  videoPort,
  videoPorts,
  comfyLogPath,
  onPortsChange,
  onRemovePort,
  className = "",
}: ComfyPanelProps) {
  const available = Boolean(comfy?.available);
  const job = comfy?.job ?? null;
  const queued = (comfy?.queueRunning ?? 0) + (comfy?.queuePending ?? 0);
  const percent = job?.percent ?? null;

  const [showSettings, setShowSettings] = useState(false);
  const [portDraft, setPortDraft] = useState(String(videoPort));
  const [logDraft, setLogDraft] = useState(comfyLogPath ?? "");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const parsedPort = parseInt(portDraft, 10);
  const portInvalid = !Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535;
  const dirty = parsedPort !== videoPort || logDraft.trim() !== (comfyLogPath ?? "");

  const openSettings = () => {
    setPortDraft(String(videoPort));
    setLogDraft(comfyLogPath ?? "");
    setSaveError(null);
    setShowSettings(true);
  };

  const handleSave = async () => {
    if (portInvalid) return;
    setSaving(true);
    setSaveError(null);
    try {
      if (logDraft.trim() !== (comfyLogPath ?? "")) {
        await updateSpark(sparkId, { comfyLogPath: logDraft.trim() });
      }
      if (parsedPort !== videoPort) {
        const next = videoPorts.map((p) => (p === videoPort ? parsedPort : p));
        const result = await updateVideoPorts(sparkId, next);
        onPortsChange?.(result.videoPorts);
      }
      setShowSettings(false);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Panel
      title="ComfyUI"
      accent={available}
      icon={<FilmIcon />}
      className={`panel-comfy ${className}`}
      actions={
        <div className="flex items-center gap-1.5">
          {onRemovePort && (
            <button
              type="button"
              title={`Remove port ${videoPort}`}
              onClick={() => onRemovePort(videoPort)}
              className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-danger transition-colors hover:bg-danger/10"
            >
              <span aria-hidden>×</span>
              Remove
            </button>
          )}
          <button
            type="button"
            title="ComfyUI settings"
            onClick={() => (showSettings ? setShowSettings(false) : openSettings())}
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-muted transition-colors hover:bg-surface-hover hover:text-text"
          >
            <GearIcon />
            Settings
          </button>
        </div>
      }
    >
      {showSettings ? (
        <div className="space-y-3">
          <label className="block space-y-1">
            <span className="text-xs text-muted">ComfyUI port</span>
            <input
              type="number"
              min={1}
              max={65535}
              inputMode="numeric"
              value={portDraft}
              onChange={(e) => {
                setPortDraft(e.target.value);
                setSaveError(null);
              }}
              className="w-full rounded-md border border-border bg-surface-elevated px-3 py-1.5 font-tabular text-sm text-text outline-none focus:border-accent"
            />
          </label>
          <label className="block space-y-1">
            <span className="text-xs text-muted">Server log path (optional)</span>
            <input
              type="text"
              spellCheck={false}
              placeholder="/path/to/comfyui.log"
              value={logDraft}
              onChange={(e) => {
                setLogDraft(e.target.value);
                setSaveError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void handleSave();
                }
              }}
              className="w-full rounded-md border border-border bg-surface-elevated px-3 py-1.5 font-mono text-xs text-text outline-none focus:border-accent"
            />
          </label>
          <p className="text-[10px] leading-snug text-muted">
            ComfyUI sends sampler progress only to the client that submitted the prompt, so
            step counts can’t be read from its API. Point this at the server log and the
            panel will show “step / steps”, s/step and ETA. Leave blank to skip.
          </p>
          {portInvalid && (
            <p className="text-[10px] text-danger">Enter an integer between 1 and 65535</p>
          )}
          {saveError && <p className="text-[10px] text-danger">{saveError}</p>}
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => setShowSettings(false)}
              disabled={saving}
              className="rounded border border-border px-2 py-1 text-[10px] text-muted hover:bg-surface-hover disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void handleSave()}
              disabled={saving || portInvalid || !dirty}
              className="rounded bg-accent px-2 py-1 text-[10px] font-medium text-white hover:bg-accent-hover disabled:opacity-50"
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      ) : !available ? (
        <div className="flex flex-wrap items-center gap-2 py-1">
          <span className="h-1.5 w-1.5 rounded-full bg-muted" />
          <p className="text-xs text-muted">
            {comfy?.error || "ComfyUI not reachable"}
          </p>
          <span className="shrink-0 font-tabular text-[10px] text-muted">:{videoPort}</span>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="llm-badge">
              <span className="h-1.5 w-1.5 rounded-full bg-accent" />
              {comfy?.version ? `v${comfy.version}` : "ComfyUI"}
            </span>
            {comfy?.pytorchVersion && (
              <span className="text-xs text-muted">torch {comfy.pytorchVersion}</span>
            )}
            <span className="ml-auto shrink-0 font-tabular text-[10px] text-muted">
              :{videoPort}
            </span>
          </div>

          {/* Job state — a progress bar only when the log gave us steps. */}
          {job ? (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs text-muted">
                  {job.step != null && job.steps != null
                    ? `Sampling ${job.step} / ${job.steps}`
                    : "Rendering"}
                </span>
                <span className="font-tabular text-sm font-semibold text-accent">
                  {formatDuration(job.elapsedSeconds)}
                </span>
              </div>
              {percent != null && (
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-elevated">
                  <div
                    className="h-full rounded-full bg-accent transition-[width] duration-500"
                    style={{ width: `${Math.min(100, Math.max(0, percent))}%` }}
                  />
                </div>
              )}
              <div className="flex items-center justify-between text-[10px] text-muted">
                <span className="truncate font-mono" title={job.id ?? undefined}>
                  {job.id ? job.id.slice(0, 8) : "—"}
                </span>
                <span className="font-tabular">
                  {job.secPerStep != null ? `${job.secPerStep.toFixed(1)} s/step` : ""}
                  {job.etaSeconds != null ? ` · ETA ${formatDuration(job.etaSeconds)}` : ""}
                </span>
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted">Status</span>
              <span className="font-tabular text-sm text-text">Idle</span>
            </div>
          )}

          <div className="grid grid-cols-3 gap-2 border-t border-border pt-3">
            <div className="space-y-0.5">
              <div className="text-[10px] uppercase tracking-wide text-muted">Queue</div>
              <div className="font-tabular text-sm text-text">
                {queued > 0
                  ? `${comfy?.queueRunning ?? 0} / ${queued}`
                  : "—"}
              </div>
            </div>
            <div className="space-y-0.5">
              <div className="text-[10px] uppercase tracking-wide text-muted">VRAM free</div>
              <div className="font-tabular text-sm text-text">
                {formatGiB(comfy?.device?.vramFree)}
              </div>
            </div>
            <div className="space-y-0.5">
              <div className="text-[10px] uppercase tracking-wide text-muted">Torch alloc</div>
              <div className="font-tabular text-sm text-text">
                {comfy?.device?.torchVramTotal != null && comfy?.device?.torchVramFree != null
                  ? formatGiB(comfy.device.torchVramTotal - comfy.device.torchVramFree)
                  : "—"}
              </div>
            </div>
          </div>

          {comfy?.lastOutput && (
            <div
              className="truncate border-t border-border pt-2 text-[10px] text-muted"
              title={`${comfy.lastOutput.subfolder ? `${comfy.lastOutput.subfolder}/` : ""}${comfy.lastOutput.filename}`}
            >
              Last output: {comfy.lastOutput.filename}
            </div>
          )}
        </div>
      )}
    </Panel>
  );
}
