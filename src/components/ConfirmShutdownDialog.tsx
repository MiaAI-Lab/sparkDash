import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useModalPresence } from "../hooks/useModalPresence";
import { PowerOffIcon } from "./ui/icons";

const CONFIRM_PHRASE = "poweroff";

interface ConfirmShutdownDialogProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void | Promise<void>;
  title: string;
  description: string;
  confirmLabel?: string;
}

function useEscape(enabled: boolean, onClose: () => void) {
  useEffect(() => {
    if (!enabled) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [enabled, onClose]);
}

export function ConfirmShutdownDialog({
  open,
  onClose,
  onConfirm,
  title,
  description,
  confirmLabel = "Shut down",
}: ConfirmShutdownDialogProps) {
  const [phrase, setPhrase] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const titleId = useId();
  const { mounted, visible } = useModalPresence(open);

  useEscape(open && !submitting, onClose);

  useEffect(() => {
    if (!open) {
      setPhrase("");
      setAcknowledged(false);
      setSubmitting(false);
      return;
    }
    const t = window.setTimeout(() => inputRef.current?.focus(), 50);
    return () => window.clearTimeout(t);
  }, [open]);

  useEffect(() => {
    if (!mounted) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [mounted]);

  const phraseOk = phrase.trim().toLowerCase() === CONFIRM_PHRASE;
  const canConfirm = phraseOk && acknowledged && !submitting;

  const handleConfirm = async () => {
    if (!canConfirm) return;
    setSubmitting(true);
    try {
      await onConfirm();
      onClose();
    } catch {
      setSubmitting(false);
    }
  };

  if (!mounted) return null;

  return createPortal(
    <div
      className={`modal-overlay${visible ? " is-open" : ""}`}
      onClick={(e) => {
        if (submitting) return;
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="modal-sheet max-w-md"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <div className="modal-sheet__header flex items-center gap-2 text-danger" id={titleId}>
          <PowerOffIcon className="h-4 w-4 shrink-0" />
          <span>Danger zone — {title}</span>
        </div>

        <div className="modal-sheet__body space-y-3">
          <p className="text-xs leading-relaxed text-muted">{description}</p>

          <div className="rounded-md border border-danger/35 bg-danger/10 px-3 py-2.5">
            <p className="text-[11px] font-medium text-danger">
              This powers off hardware. Running containers and sessions will stop.
            </p>
          </div>

          <label className="flex cursor-pointer items-start gap-2.5 text-xs text-text">
            <input
              type="checkbox"
              checked={acknowledged}
              disabled={submitting}
              onChange={(e) => setAcknowledged(e.target.checked)}
              className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-[var(--color-danger)]"
            />
            <span>I understand this cannot be undone from the dashboard.</span>
          </label>

          <div>
            <label className="mb-1 block text-xs text-muted">
              Type <span className="font-mono text-danger">{CONFIRM_PHRASE}</span> to confirm
            </label>
            <input
              ref={inputRef}
              type="text"
              autoComplete="off"
              spellCheck={false}
              value={phrase}
              disabled={submitting}
              onChange={(e) => setPhrase(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void handleConfirm();
                }
              }}
              className="w-full rounded border border-border bg-surface-elevated px-3 py-1.5 font-mono text-xs text-text outline-none focus:border-danger"
              placeholder={CONFIRM_PHRASE}
            />
          </div>
        </div>

        <div className="modal-sheet__footer">
          <div className="modal-sheet__footer-actions">
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              className="rounded-md border border-border bg-surface-elevated px-3 py-1.5 text-xs text-muted transition-colors hover:bg-surface-hover hover:text-text disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void handleConfirm()}
              disabled={!canConfirm}
              className="rounded-md border border-danger/50 bg-danger px-3 py-1.5 text-xs font-medium text-white transition-colors hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {submitting ? "Shutting down…" : confirmLabel}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
