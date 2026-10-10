import { useCallback, useEffect, useState } from "react";
import { BoltIcon } from "../ui/icons";

/**
 * In-app PWA install prompt.
 *
 * - Chrome/Android/desktop: the browser fires `beforeinstallprompt`; we capture
 *   it and show our own banner whose button calls prompt() (the native
 *   "Install app" dialog).
 * - iOS Safari: no programmatic prompt exists, so we show a one-time hint with
 *   the manual Share → Add to Home Screen steps.
 * - Hidden when already running as an installed app (standalone display mode)
 *   or after the user dismisses it (stored in localStorage).
 */

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

const DISMISS_KEY = "sparkdash.install.dismissed";
const IOS_HINT_KEY = "sparkdash.install.iosHintShown";

function isStandalone(): boolean {
  return (
    window.matchMedia?.("(display-mode: standalone)").matches ||
    window.matchMedia?.("(display-mode: fullscreen)").matches ||
    window.matchMedia?.("(display-mode: minimal-ui)").matches ||
    // iOS Safari reports standalone via this legacy API.
    (window.navigator as unknown as { standalone?: boolean }).standalone === true
  );
}

function isIOS(): boolean {
  return /iphone|ipad|ipod/i.test(window.navigator.userAgent) || (window.navigator.platform === "MacIntel" && window.navigator.maxTouchPoints > 1);
}

type BannerKind = "none" | "native" | "ios";

export function InstallPrompt() {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [kind, setKind] = useState<BannerKind>("none");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (isStandalone()) return; // already installed

    const dismissed = (() => {
      try {
        return localStorage.getItem(DISMISS_KEY) === "1";
      } catch {
        return false;
      }
    })();

    const onBeforeInstall = (e: Event) => {
      e.preventDefault(); // suppress the browser's own mini-banner; we prompt from our UI
      setDeferred(e as BeforeInstallPromptEvent);
      if (!dismissed) setKind("native");
    };

    const onInstalled = () => {
      setDeferred(null);
      setKind("none");
      try {
        localStorage.setItem(DISMISS_KEY, "1");
      } catch {
        /* ignore */
      }
    };

    window.addEventListener("beforeinstallprompt", onBeforeInstall);
    window.addEventListener("appinstalled", onInstalled);

    // iOS fallback: no beforeinstallprompt fires there. Show the manual-steps
    // hint once per device (only on a visit where the page is loaded, not installed).
    if (!dismissed && isIOS()) {
      let shown = false;
      try {
        shown = localStorage.getItem(IOS_HINT_KEY) === "1";
      } catch {
        /* ignore */
      }
      if (!shown) setKind("ios");
    }

    // Chrome can defer the event until after load; also re-check standalone
    // (user may have installed while the tab was open).
    const mq = window.matchMedia?.("(display-mode: standalone)");
    const onModeChange = () => {
      if (isStandalone()) onInstalled();
    };
    mq?.addEventListener?.("change", onModeChange);

    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstall);
      window.removeEventListener("appinstalled", onInstalled);
      mq?.removeEventListener?.("change", onModeChange);
    };
  }, []);

  const dismiss = useCallback(() => {
    setKind("none");
    try {
      localStorage.setItem(kind === "ios" ? IOS_HINT_KEY : DISMISS_KEY, "1");
    } catch {
      /* ignore */
    }
  }, [kind]);

  const install = useCallback(async () => {
    if (!deferred) return;
    setBusy(true);
    try {
      await deferred.prompt();
      const { outcome } = await deferred.userChoice;
      if (outcome === "accepted") {
        try {
          localStorage.setItem(DISMISS_KEY, "1");
        } catch {
          /* ignore */
        }
        setKind("none");
      }
    } catch {
      /* prompt failed — leave banner visible so the user can retry */
    } finally {
      // The event is single-use; drop it either way.
      setDeferred(null);
      setBusy(false);
    }
  }, [deferred]);

  if (kind === "none") return null;

  return (
    <div
      role="dialog"
      aria-label="Install sparkDash"
      className="fixed inset-x-3 bottom-[76px] z-50 mx-auto flex max-w-md items-center gap-3 rounded-xl border p-3 shadow-lg sm:inset-x-auto sm:bottom-4 sm:left-4"
      style={{
        background: "var(--color-surface-elevated)",
        borderColor: "var(--color-border-strong)",
        color: "var(--color-text)",
      }}
    >
      <BoltIcon className="h-5 w-5 shrink-0" />
      {kind === "native" ? (
        <>
          <div className="min-w-0 flex-1 text-sm leading-tight">
            <span className="font-medium" style={{ color: "var(--color-text-strong)" }}>
              Install sparkDash
            </span>
            <span className="block text-xs" style={{ color: "var(--color-muted)" }}>
              Add to your home screen for a fullscreen, app-like dashboard.
            </span>
          </div>
          <button
            type="button"
            onClick={install}
            disabled={busy}
            className="shrink-0 rounded-lg px-3 py-1.5 text-sm font-medium disabled:opacity-60"
            style={{ background: "var(--color-accent)", color: "var(--color-on-accent)" }}
          >
            {busy ? "…" : "Install"}
          </button>
        </>
      ) : (
        <div className="min-w-0 flex-1 text-sm leading-tight">
          <span className="font-medium" style={{ color: "var(--color-text-strong)" }}>
            Install sparkDash on your iPhone
          </span>
          <span className="mt-0.5 block text-xs" style={{ color: "var(--color-muted)" }}>
            Tap the <strong>Share</strong> icon <span aria-hidden>⬆︎</span> in Safari, then{" "}
            <strong>Add to Home Screen</strong>.
          </span>
        </div>
      )}
      <button
        type="button"
        onClick={dismiss}
        aria-label="Dismiss"
        className="shrink-0 rounded-md px-1.5 py-1 text-sm"
        style={{ color: "var(--color-muted)" }}
      >
        ✕
      </button>
    </div>
  );
}
