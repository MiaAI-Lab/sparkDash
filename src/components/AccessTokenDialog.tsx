import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { useModalPresence } from "../hooks/useModalPresence";
import { useOverlayClose } from "../hooks/useOverlayClose";
import { useFocusTrap } from "../hooks/useFocusTrap";
import {
  fetchAuthStatus,
  getToken,
  onAuthRequired,
  setToken,
  type AuthPromptReason,
} from "../api/authToken";

interface AccessTokenDialogProps {
  open: boolean;
  reason: AuthPromptReason;
  /** `saved` is true when the dialog closed because a token was stored. */
  onClose: (saved?: boolean) => void;
}

type AccessTokenError = "rejected" | "savedRejected";

export function AccessTokenDialog({ open, reason, onClose }: AccessTokenDialogProps) {
  const { t } = useTranslation("devices");
  const [value, setValue] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<AccessTokenError | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const titleId = useId();
  const { mounted, visible } = useModalPresence(open);
  const trapRef = useFocusTrap(mounted);
  const overlayClose = useOverlayClose(() => onClose(false), !submitting);

  useEffect(() => {
    if (!open) {
      setValue("");
      setSubmitting(false);
      setError(null);
      return;
    }
    // Reopened by a refusal while a token is stored: that token is the problem.
    setError(reason === "rejected" && getToken() ? "savedRejected" : null);
    const t = window.setTimeout(() => inputRef.current?.focus(), 50);
    return () => window.clearTimeout(t);
  }, [open, reason]);

  // Capture-phase Escape so a dialog underneath (Settings) does not close too.
  useEffect(() => {
    if (!open || submitting) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onClose(false);
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [open, submitting, onClose]);

  const candidate = value.trim();

  const handleSave = async () => {
    if (!candidate || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const status = await fetchAuthStatus(candidate);
      if (status.tokenRequired && !status.authenticated) {
        setError("rejected");
        setSubmitting(false);
        return;
      }
    } catch {
      // Could not verify (server unreachable); keep the token and let the
      // next request decide.
    }
    setToken(candidate);
    onClose(true);
  };

  if (!mounted) return null;

  return createPortal(
    <div
      className={`modal-overlay${visible ? " is-open" : ""}`}
      {...overlayClose}
    >
      <div
        ref={trapRef}
        className="modal-sheet max-w-md"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <div className="modal-sheet__header" id={titleId}>
          {t("accessToken.title")}
        </div>

        <div className="modal-sheet__body space-y-3">
          <p className="text-xs leading-relaxed text-muted">
            {reason === "rejected"
              ? t("accessToken.descriptionRejected")
              : t("accessToken.description")}{" "}
            {t("accessToken.storedLocally")}
          </p>

          <div>
            <label htmlFor={`${titleId}-input`} className="mb-1 block text-xs text-muted">
              {t("accessToken.label")}
            </label>
            <input
              ref={inputRef}
              id={`${titleId}-input`}
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={value}
              disabled={submitting}
              onChange={(e) => {
                setValue(e.target.value);
                if (error) setError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void handleSave();
                }
              }}
              className="w-full rounded border border-border bg-surface-elevated px-3 py-1.5 font-mono text-xs text-text outline-none focus:border-accent"
            />
          </div>

          {error && (
            <div role="alert" className="rounded bg-danger/20 px-3 py-2 text-xs text-danger">
              {error === "rejected" ? t("accessToken.errors.rejected") : t("accessToken.errors.savedRejected")}
            </div>
          )}
        </div>

        <div className="modal-sheet__footer">
          <div className="modal-sheet__footer-actions">
            <button
              type="button"
              onClick={() => onClose(false)}
              disabled={submitting}
              className="rounded-md border border-border bg-surface-elevated px-3 py-1.5 text-xs text-muted transition-colors hover:bg-surface-hover hover:text-text disabled:opacity-50"
            >
              {t("actions.cancel")}
            </button>
            <button
              type="button"
              onClick={() => void handleSave()}
              disabled={!candidate || submitting}
              className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
            >
              {submitting ? t("actions.checking") : t("actions.save")}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}

/**
 * App-level host for the dialog: opens it whenever the API layer reports a
 * refused token (401, or a WebSocket the server turned away) or Settings asks
 * to change it. After Cancel it stays quiet for that token, so background
 * polling cannot pop it up again; a new token or a manual request re-arms it.
 */
export function AccessTokenPrompt() {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<AuthPromptReason>("rejected");
  const openRef = useRef(false);
  const dismissedFor = useRef<string | null>(null);

  useEffect(
    () =>
      onAuthRequired((next) => {
        if (openRef.current) return;
        if (next === "rejected" && dismissedFor.current === getToken()) return;
        openRef.current = true;
        setReason(next);
        setOpen(true);
      }),
    []
  );

  const handleClose = useCallback((saved?: boolean) => {
    openRef.current = false;
    dismissedFor.current = saved ? null : getToken();
    setOpen(false);
  }, []);

  return <AccessTokenDialog open={open} reason={reason} onClose={handleClose} />;
}
