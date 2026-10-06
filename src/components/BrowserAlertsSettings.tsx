import { useState } from "react";
import { notificationSupport, useBrowserAlertPrefs } from "../hooks/useBrowserAlerts";

function Toggle({ on, onClick, disabled, label }: { on: boolean; onClick: () => void; disabled?: boolean; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={`toggle-track relative mt-0.5 inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
        on ? "is-on" : ""
      }`}
    >
      <span
        className={`toggle-dot inline-block h-4 w-4 transform rounded-full shadow transition-transform ${
          on ? "translate-x-4" : "translate-x-0"
        }`}
      />
    </button>
  );
}

/**
 * Settings → Browser alerts. Per browser (localStorage), saved on click —
 * not part of the server settings the dialog's Save button writes.
 */
export function BrowserAlertsSettings() {
  const [prefs, setPrefs] = useBrowserAlertPrefs();
  const support = notificationSupport();
  const [note, setNote] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const permission = support === "ok" ? Notification.permission : null;

  const toggleDesktop = async () => {
    if (prefs.desktop) {
      setPrefs({ ...prefs, desktop: false });
      setNote(null);
      return;
    }
    if (support !== "ok") return;
    setAsking(true);
    try {
      // Only ever asked from this click: browsers ignore (or punish) a
      // permission prompt that is not tied to a user gesture.
      const result = Notification.permission === "default" ? await Notification.requestPermission() : Notification.permission;
      if (result === "granted") {
        setPrefs({ ...prefs, desktop: true });
        setNote(null);
      } else {
        setNote("Notifications are blocked for this site. Allow them in the browser's site settings, then turn this on again.");
      }
    } catch {
      setNote("This browser refused the notification permission request.");
    } finally {
      setAsking(false);
    }
  };

  return (
    <div className="space-y-2" data-testid="browser-alerts">
      <span className="block text-xs text-text">Browser alerts</span>
      <span className="-mt-1 block text-[10px] leading-snug text-muted">
        For active alerts (the server's when Alerts is on, otherwise the Overview exceptions). This browser only —
        saved immediately.
      </span>
      <label className="flex items-start gap-3 text-xs text-muted">
        <Toggle on={prefs.tabBadge} label="Tab badge" onClick={() => setPrefs({ ...prefs, tabBadge: !prefs.tabBadge })} />
        <span>
          <span className="block text-text">Tab badge</span>
          <span className="mt-0.5 block text-[10px] leading-snug text-muted">
            The tab title shows the count — “(2) sparkDash” — and the icon gets a red (critical) or amber dot.
          </span>
        </span>
      </label>
      <label className="flex items-start gap-3 text-xs text-muted">
        <Toggle
          on={prefs.desktop && support === "ok"}
          label="Desktop notifications"
          disabled={support !== "ok" || asking}
          onClick={() => void toggleDesktop()}
        />
        <span>
          <span className="block text-text">Desktop notifications</span>
          <span className="mt-0.5 block text-[10px] leading-snug text-muted">
            A notification when an alert starts firing, while this page is open.
          </span>
          {support === "insecure" && (
            <span className="mt-1 block text-[10px] leading-snug text-warning" role="note">
              Browsers only allow notifications on HTTPS or localhost, and this page is plain HTTP. Open sparkDash through
              an SSH tunnel (localhost), Tailscale Serve or an HTTPS reverse proxy to use them — or use Alerts → ntfy for
              phone and desktop pushes.
            </span>
          )}
          {support === "unsupported" && (
            <span className="mt-1 block text-[10px] leading-snug text-muted" role="note">
              This browser does not support desktop notifications.
            </span>
          )}
          {support === "ok" && prefs.desktop && permission === "denied" && (
            <span className="mt-1 block text-[10px] leading-snug text-warning" role="note">
              Permission was withdrawn in the browser; nothing will be shown until it is allowed again.
            </span>
          )}
          {note && (
            <span className="mt-1 block text-[10px] leading-snug text-warning" role="note">
              {note}
            </span>
          )}
        </span>
      </label>
    </div>
  );
}
