import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { useModalPresence } from "../hooks/useModalPresence";
import { useOverlayClose } from "../hooks/useOverlayClose";
import { useFocusTrap } from "../hooks/useFocusTrap";
import { PowerOffIcon } from "./ui/icons";
import "../styles/dialogs.css";

const CONFIRM_PHRASE = "poweroff";

interface ConfirmShutdownDialogProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void | Promise<void>;
  title: string;
  description: string;
  confirmLabel?: string;
  /** Lines naming running work this action will stop; rendered in a danger box. */
  warnings?: string[];
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
  warnings,
}: ConfirmShutdownDialogProps) {
  const { t } = useTranslation("overview");
  const [phrase, setPhrase] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const titleId = useId();
  const { mounted, visible } = useModalPresence(open);
  const trapRef = useFocusTrap(mounted);
  const overlayClose = useOverlayClose(onClose, !submitting);

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
      {...overlayClose}
    >
      <div
        ref={trapRef}
        className="modal-sheet modal-sheet--narrow"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <div className="modal-sheet__header modal-sheet__header--danger">
          <PowerOffIcon className="h-4 w-4 shrink-0" />
          <h2 className="modal-sheet__title" id={titleId}>
            {t("shutdown.dangerZone", { title })}
          </h2>
        </div>

        <div className="modal-sheet__body modal-sheet__stack">
          <p className="modal-sheet__lead">{description}</p>

          <div className="danger-box" role="alert">
            <b>
              {warnings && warnings.length > 0
                ? t("shutdown.stopsWork")
                : t("shutdown.powersOffHardware")}
            </b>
            {warnings && warnings.length > 0 ? (
              <ul>
                {warnings.map((w, i) => (
                  <li key={`${i}-${w}`}>{w}</li>
                ))}
              </ul>
            ) : null}
            <span>{t("shutdown.runningWorkStops")}</span>
          </div>

          <label className="check-row">
            <input
              type="checkbox"
              checked={acknowledged}
              disabled={submitting}
              onChange={(e) => setAcknowledged(e.target.checked)}
            />
            <span>{t("shutdown.acknowledgment")}</span>
          </label>

          <div className="field">
            <label htmlFor={`${titleId}-phrase`}>
              {t("shutdown.typeToConfirmPrefix")} <b className="mono">{CONFIRM_PHRASE}</b> {t("shutdown.typeToConfirmSuffix")}
            </label>
            <input
              id={`${titleId}-phrase`}
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
              className="field-input field-input--mono"
              placeholder={CONFIRM_PHRASE}
            />
          </div>
        </div>

        <div className="modal-sheet__footer">
          <div className="modal-sheet__footer-actions">
            <button type="button" onClick={onClose} disabled={submitting} className="btn btn--ghost">
              {t("shutdown.cancel")}
            </button>
            <button
              type="button"
              onClick={() => void handleConfirm()}
              disabled={!canConfirm}
              className="btn btn--danger"
            >
              <PowerOffIcon className="h-3.5 w-3.5" />
              {submitting ? t("shutdown.submitting") : confirmLabel}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
