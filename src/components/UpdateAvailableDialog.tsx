import { useEffect, useId } from "react";
import { createPortal } from "react-dom";
import type { UpdateStatus } from "../api/types";
import { useModalPresence } from "../hooks/useModalPresence";
import { useOverlayClose } from "../hooks/useOverlayClose";
import { useFocusTrap } from "../hooks/useFocusTrap";
import { CopyButton } from "./bench/tooleval/parts";
import { ChangelogBody } from "./SparkPage/HermesUpdateDialog";
import { XIcon } from "./ui/icons";
import "../styles/dialogs.css";

/** Browser-local: the version this browser already said "not now" to. */
export const UPDATE_DISMISSED_KEY = "sparkdash.update.dismissed";
/** No self-update: the operator pulls and rebuilds on the host. */
export const UPGRADE_COMMAND = "git pull && docker compose up -d --build";
export const CHANGELOG_URL = "https://github.com/MiaAI-Lab/sparkDash/blob/main/CHANGELOG.md";

export function readDismissedVersion(): string | null {
  try {
    return localStorage.getItem(UPDATE_DISMISSED_KEY);
  } catch {
    return null;
  }
}

export function rememberDismissedVersion(version: string): void {
  try {
    localStorage.setItem(UPDATE_DISMISSED_KEY, version);
  } catch {
    /* Browser storage is optional; the dialog still closes for this session. */
  }
}

/**
 * A notice is worth opening once per upstream version per browser. A later
 * upstream version has a different `latestVersion`, so it opens again.
 */
export function shouldOfferUpdate(
  status: UpdateStatus | null,
  dismissedVersion: string | null,
): boolean {
  return (
    status?.updateAvailable === true &&
    Boolean(status.latestVersion) &&
    status.latestVersion !== dismissedVersion
  );
}

interface UpdateAvailableDialogProps {
  status: UpdateStatus | null;
  open: boolean;
  /** All close paths (X, Escape, overlay, "Not now") dismiss this version. */
  onClose: () => void;
}

/**
 * Notify-only by design: sparkDash runs from a checkout the operator deploys, so
 * the dashboard names the new version and the command instead of replacing code.
 */
export function UpdateAvailableDialog({ status, open, onClose }: UpdateAvailableDialogProps) {
  const titleId = useId();
  const { mounted, visible } = useModalPresence(open);
  const trapRef = useFocusTrap(mounted);
  const overlayClose = useOverlayClose(onClose);

  // Capture phase so a dialog underneath does not also close — and only while
  // this dialog owns focus: a later dialog (palette, Settings) above it moves
  // focus away, and must keep Escape for itself.
  useEffect(() => {
    if (!open) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (!(event.target instanceof Node) || !trapRef.current?.contains(event.target)) return;
      event.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [open, onClose]);

  if (!mounted || !status) return null;

  const latest = status.latestVersion ?? "";
  const current = status.currentVersion ?? "unknown";

  return createPortal(
    <div className={`modal-overlay${visible ? " is-open" : ""}`} {...overlayClose}>
      <div
        ref={trapRef}
        className="modal-sheet max-w-md"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <div className="modal-sheet__header">
          <span className="modal-sheet__title" id={titleId}>
            Update available
          </span>
          <button type="button" className="modal-sheet__close" onClick={onClose} aria-label="Close">
            <XIcon className="h-4 w-4" />
          </button>
        </div>

        <div className="modal-sheet__body space-y-3">
          <p className="text-xs leading-relaxed text-muted">
            sparkDash <strong className="text-text-strong">v{latest}</strong> is available. This
            server is running <strong className="text-text-strong">v{current}</strong>.
          </p>
          {status.notes ? (
            <div className="max-h-56 overflow-y-auto rounded border border-border bg-surface-elevated p-2.5">
              <ChangelogBody body={status.notes} />
            </div>
          ) : (
            <p className="text-xs leading-relaxed text-muted">
              Release notes are in the changelog.
            </p>
          )}
          <p className="text-xs leading-relaxed text-muted">
            On the host, in your sparkDash checkout, run:
          </p>
          <div className="flex items-start gap-2 rounded border border-border bg-surface-elevated p-2.5">
            <code className="min-w-0 flex-1 break-all font-mono text-[11px] leading-relaxed text-text">
              {UPGRADE_COMMAND}
            </code>
            <CopyButton text={UPGRADE_COMMAND} />
          </div>
          <p className="text-xs leading-relaxed text-muted">
            Settings and history live on the host and are kept. sparkDash never updates itself.
          </p>
        </div>

        <div className="modal-sheet__footer">
          <a
            className="btn btn--sm btn--ghost"
            href={CHANGELOG_URL}
            target="_blank"
            rel="noopener noreferrer"
          >
            Full changelog
          </a>
          <div className="modal-sheet__footer-actions">
            <button type="button" className="btn btn--sm" onClick={onClose}>
              Not now
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
