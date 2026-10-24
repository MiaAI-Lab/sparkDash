import { useCallback, useEffect, useId, useRef, useState, type ReactElement, type ReactPortal } from "react";
import { createPortal } from "react-dom";
import { useModalPresence } from "../hooks/useModalPresence";
import { useOverlayClose } from "../hooks/useOverlayClose";
import { useFocusTrap } from "../hooks/useFocusTrap";
import {
  fetchAuthStatus,
  getToken,
  onAuthRequired,
  onSessionChange,
  setToken,
  type AuthPromptReason,
} from "../api/authToken";
import { browserSupportsWebAuthn } from "@simplewebauthn/browser";
import { isPasskeyCancelled, signInWithPasskey, signInWithToken } from "../api/passkeys";

interface AccessTokenDialogProps {
  open: boolean;
  reason: AuthPromptReason;
  /** `saved` is true when the dialog closed because a token was stored or a sign-in succeeded. */
  onClose: (saved?: boolean) => void;
}

const REJECTED_MESSAGE = "The server rejected this token. Check SPARKDASH_TOKEN on the host and try again.";

/**
 * Without passkeys it stores the access token in this browser. With passkeys
 * armed on the host it is a "Sign in" dialog: a passkey, or a one-time exchange
 * of the access token for a session cookie (the token is then not stored).
 */
export function AccessTokenDialog({ open, reason, onClose }: AccessTokenDialogProps): ReactPortal | null {
  const [value, setValue] = useState("");
  const [submitting, setSubmitting] = useState<"token" | "passkey" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** null until the server says whether passkeys are armed. */
  const [passkeys, setPasskeys] = useState<boolean | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const titleId = useId();
  const { mounted, visible } = useModalPresence(open);
  const trapRef = useFocusTrap(mounted);
  const busy = submitting !== null;
  const overlayClose = useOverlayClose(() => onClose(false), !busy);

  useEffect(() => {
    if (!open) {
      setValue("");
      setSubmitting(null);
      setError(null);
      setNotice(null);
      setPasskeys(null);
      return;
    }
    // Reopened by a refusal while a token is stored: that token is the problem.
    setError(reason === "rejected" && getToken() ? "The saved token was rejected by the server." : null);
    let cancelled = false;
    fetchAuthStatus()
      .then((status) => {
        if (!cancelled) setPasskeys(status.passkeys.enabled);
      })
      .catch(() => {
        // Server unreachable: offer what works without it, storing the token.
        if (!cancelled) setPasskeys(false);
      });
    const t = window.setTimeout(() => inputRef.current?.focus(), 50);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [open, reason]);

  // Capture-phase Escape so a dialog underneath (Settings) does not close too.
  useEffect(() => {
    if (!open || busy) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onClose(false);
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [open, busy, onClose]);

  const candidate = value.trim();
  const passkeyCapable = passkeys === true && browserSupportsWebAuthn();
  let saveLabel = "Save";
  if (passkeys) {
    saveLabel = submitting === "token" ? "Signing in…" : "Sign in with token";
  } else if (submitting) {
    saveLabel = "Checking…";
  }

  async function handleSave(): Promise<void> {
    if (!candidate || busy || passkeys === null) return;
    setSubmitting("token");
    setError(null);
    setNotice(null);
    if (passkeys) {
      try {
        await signInWithToken(candidate);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        // A store fault can disarm passkeys after this dialog opened. Refresh the
        // posture so the operator's valid token still has a browser sign-in path.
        try {
          const status = await fetchAuthStatus();
          if (!status.passkeys.enabled) setPasskeys(false);
        } catch {
          // No new posture is known; keep the sign-in mode and original error.
        }
        setSubmitting(null);
        return;
      }
      onClose(true);
      return;
    }
    try {
      const status = await fetchAuthStatus(candidate);
      if (status.tokenRequired && !status.authenticated) {
        setError(REJECTED_MESSAGE);
        setSubmitting(null);
        return;
      }
    } catch {
      // Could not verify (server unreachable); keep the token and let the
      // next request decide.
    }
    setToken(candidate);
    onClose(true);
  }

  async function handlePasskey(): Promise<void> {
    if (busy) return;
    setSubmitting("passkey");
    setError(null);
    setNotice(null);
    try {
      await signInWithPasskey();
    } catch (err) {
      if (isPasskeyCancelled(err)) setNotice("Passkey sign-in was cancelled or timed out.");
      else setError(err instanceof Error ? err.message : String(err));
      setSubmitting(null);
      return;
    }
    onClose(true);
  }

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
          {passkeys ? "Sign in" : "Access token"}
        </div>

        <div className="modal-sheet__body space-y-3">
          {passkeys ? (
            <>
              <p className="text-xs leading-relaxed text-muted">
                {reason === "rejected"
                  ? "This sparkDash server requires a sign-in for live telemetry and changes."
                  : "Sign in to this sparkDash server."}{" "}
                This browser then stays signed in without storing the token.
              </p>
              {passkeyCapable ? (
                <button
                  type="button"
                  onClick={() => void handlePasskey()}
                  disabled={busy}
                  className="w-full rounded-md bg-accent px-3 py-2 text-xs font-medium text-white transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {submitting === "passkey" ? "Waiting for the passkey…" : "Sign in with a passkey"}
                </button>
              ) : (
                <p className="text-xs leading-relaxed text-muted" data-testid="passkey-unsupported">
                  This browser cannot use a passkey here: passkeys need a supporting browser and an HTTPS (or
                  localhost) address. Sign in with the access token instead.
                </p>
              )}
            </>
          ) : (
            <p className="text-xs leading-relaxed text-muted">
              {reason === "rejected"
                ? "This sparkDash server requires an access token for live telemetry and changes. Enter the value of SPARKDASH_TOKEN set on the host."
                : "Enter the value of SPARKDASH_TOKEN set on the host."}{" "}
              It is stored in this browser only.
            </p>
          )}

          <div>
            <label htmlFor={`${titleId}-input`} className="mb-1 block text-xs text-muted">
              {passkeys ? "Sign in with the access token" : "Token"}
            </label>
            <input
              ref={inputRef}
              id={`${titleId}-input`}
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={value}
              disabled={busy}
              onChange={(e) => {
                setValue(e.target.value);
                if (error) setError(null);
                if (notice) setNotice(null);
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
              {error}
            </div>
          )}
          {notice && (
            <p role="status" className="text-xs text-muted">
              {notice}
            </p>
          )}
        </div>

        <div className="modal-sheet__footer">
          <div className="modal-sheet__footer-actions">
            <button
              type="button"
              onClick={() => onClose(false)}
              disabled={busy}
              className="rounded-md border border-border bg-surface-elevated px-3 py-1.5 text-xs text-muted transition-colors hover:bg-surface-hover hover:text-text disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void handleSave()}
              disabled={!candidate || busy || passkeys === null}
              className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
            >
              {saveLabel}
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
 * polling cannot pop it up again; a new token, a sign-in or sign-out, or a
 * manual request re-arms it.
 */
export function AccessTokenPrompt(): ReactElement {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<AuthPromptReason>("rejected");
  const openRef = useRef(false);
  const dismissedFor = useRef<string | null>(null);

  useEffect(
    () =>
      onSessionChange(() => {
        dismissedFor.current = null;
      }),
    []
  );

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
