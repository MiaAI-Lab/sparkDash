import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useModalPresence } from "../../../hooks/useModalPresence";
import {
  closeModelCommandDialog,
  useModelCommandDialog,
  type ModelCommandTarget,
} from "../../../hooks/useModelCommandDialog";
import { deleteModelJob } from "../../../api/modelClient";
import type { ModelJob } from "../../../api/modelTypes";
import { LogConsole, releaseJob } from "./LogConsole";
import { BoltIcon, RotateIcon } from "../../ui/icons";

function useEscape(onClose: () => void, enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose, enabled]);
}

function useBodyScrollLock(locked: boolean) {
  useEffect(() => {
    if (!locked) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [locked]);
}

const ACTION_TITLE: Record<string, string> = {
  start: "Start",
  stop: "Stop",
  restart: "Restart",
  logs: "Logs",
};

/**
 * Modal host for a model command's live transcript.
 *
 * Mounted once in App.tsx and driven by the useModelCommandDialog store, so
 * any card can open it. Closing does NOT stop the host script — the script
 * runs in its own process group on the host and (for `start.sh`) tails the
 * container logs forever, which is exactly why the container must survive the
 * modal being closed. Only a `logs` tail is released, and only on unmount.
 */
export function ModelCommandDialog() {
  const target = useModelCommandDialog();
  const { mounted, visible } = useModalPresence(target != null);
  useEscape(closeModelCommandDialog, target != null && mounted);
  useBodyScrollLock(target != null && mounted);

  const [settled, setSettled] = useState<ModelJob | null>(null);
  const [cancelling, setCancelling] = useState(false);

  useEffect(() => {
    setSettled(null);
    setCancelling(false);
  }, [target?.jobId]);

  // Release the transcript ONLY when the dialog genuinely goes away (or the
  // user switches to a different job). Deliberately NOT driven by `mounted`:
  // presence keeps `mounted` false until the enter animation flips it, so a
  // mounted-based guard fires on OPEN and would cancel a freshly-started logs
  // tail before it can stream. We remember the previous target and release it
  // when it disappears / changes — a true close or job switch, never an open.
  const prevTarget = useRef<ModelCommandTarget | null | undefined>(undefined);
  useEffect(() => {
    const prev = prevTarget.current;
    prevTarget.current = target;
    // Undefined on the very first commit: nothing to release.
    if (prev === undefined) return;
    if (prev && (!target || prev.jobId !== target.jobId)) {
      releaseJob(prev.jobId, prev.action);
    }
  }, [target]);

  const onSettled = useCallback((job: ModelJob) => setSettled(job), []);

  const handleCancel = async () => {
    if (!target) return;
    setCancelling(true);
    try {
      // Explicit force: this is the only UI path that may tear a running
      // script's process group down. Containers already created survive.
      await deleteModelJob(target.jobId, true);
    } catch {
      /* job may already have finished */
    } finally {
      setCancelling(false);
    }
  };

  if (!mounted || !target) return null;

  const running = !settled || settled.status === "running";
  const title = `${ACTION_TITLE[target.action] || target.action} — ${target.modelName}`;

  return createPortal(
    <div
      className={`modal-overlay${visible ? " is-open" : ""}`}
      onClick={(e) => {
        if (e.target === e.currentTarget) closeModelCommandDialog();
      }}
    >
      <div
        className="modal-sheet modal-sheet--command"
        role="dialog"
        aria-modal="true"
        aria-labelledby="model-command-title"
      >
        <header className="modal-sheet__header" id="model-command-title">
          <div className="flex items-center gap-2">
            {running ? (
              <RotateIcon className="h-4 w-4 shrink-0 animate-spin text-accent" />
            ) : (
              <BoltIcon className="h-4 w-4 shrink-0 text-accent" />
            )}
            <span>{title}</span>
          </div>
          <p className="mt-1 text-xs font-normal text-muted">
            {target.action === "logs" ? (
              <>
                Tailing this container's logs —{" "}
                <span className="font-tabular">closing this window stops the tail</span>. The model
                keeps running.
              </>
            ) : (
              <>
                Runs on the host via <span className="font-tabular">nsenter</span> as the repo owner
                — closing this window does not stop the script.
              </>
            )}
            {target.stopping && target.stopping.length > 0 && (
              <> Stopping {target.stopping.length} other model{target.stopping.length > 1 ? "s" : ""} first.</>
            )}
          </p>
        </header>

        <div className="modal-sheet__body flex min-h-0 flex-col">
          <LogConsole jobId={target.jobId} onSettled={onSettled} />
        </div>

        <div className="modal-sheet__footer">
          <div className="modal-sheet__footer-actions" style={{ marginLeft: "auto" }}>
            {running && target.action !== "logs" && (
              <button
                type="button"
                onClick={() => void handleCancel()}
                disabled={cancelling}
                className="rounded border border-danger/40 px-3 py-1.5 text-xs text-danger transition-colors hover:bg-danger/15 disabled:opacity-50"
                title="Kill the script's process group. Containers already started by Docker keep running."
              >
                {cancelling ? "Cancelling…" : "Cancel script"}
              </button>
            )}
            <button
              type="button"
              onClick={closeModelCommandDialog}
              className="rounded bg-accent px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-accent-hover"
            >
              Close
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
