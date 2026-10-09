import { useEffect, useRef, useState } from "react";
import type { AuthMode } from "../api/types";

export const OPEN_ACCESS_DISMISSED_KEY = "sparkdash.ui.openAccessDismissed";

const EXPLANATION =
  "This dashboard is reachable from your network without a token, so anyone on it can change settings. Set SPARKDASH_TOKEN on the server to require one.";

function readDismissed(): boolean {
  try {
    return localStorage.getItem(OPEN_ACCESS_DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}

function writeDismissed() {
  try {
    localStorage.setItem(OPEN_ACCESS_DISMISSED_KEY, "1");
  } catch {
    /* storage blocked — dismissal lasts for this page view only */
  }
}

/**
 * Header warning shown only when /api/health reports `authMode: "open-remote"`:
 * the server is bound off loopback with no SPARKDASH_TOKEN, so it is open to the
 * network. Dismissible per browser.
 */
export function OpenAccessChip({ authMode }: { authMode: AuthMode | null }) {
  const [dismissed, setDismissed] = useState(readDismissed);
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (authMode !== "open-remote" || dismissed) return null;

  const dismiss = () => {
    writeDismissed();
    setDismissed(true);
    setOpen(false);
  };

  return (
    <div ref={wrapperRef} className="open-access">
      <button
        type="button"
        className="open-access-chip"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls="open-access-popover"
        title={EXPLANATION}
      >
        <span className="open-access-dot" aria-hidden="true" />
        Open access
      </button>
      {open && (
        <div id="open-access-popover" className="open-access-popover" role="dialog" aria-label="Open access">
          <p>{EXPLANATION}</p>
          <button type="button" className="open-access-dismiss" onClick={dismiss}>
            Don't show again
          </button>
        </div>
      )}
    </div>
  );
}
