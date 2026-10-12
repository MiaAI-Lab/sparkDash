import { useState } from "react";
import { notificationSupport, useBrowserAlertPrefs } from "../hooks/useBrowserAlerts";
import { ToggleRow } from "./SettingRows";

/**
 * Settings → Tab badge / Desktop notifications. Per browser (localStorage),
 * saved on click — not part of the server settings the dialog's Save writes.
 * Both count what the Overview exceptions strip lists.
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

  let desktopNote: string | null = note;
  if (!desktopNote && support === "insecure") {
    desktopNote = "Browsers only allow notifications on HTTPS or localhost, and this page is plain HTTP. Use an SSH tunnel, Tailscale Serve or an HTTPS proxy — or an ntfy channel under Alert notifications.";
  } else if (!desktopNote && support === "unsupported") {
    desktopNote = "This browser does not support desktop notifications.";
  } else if (!desktopNote && support === "ok" && prefs.desktop && permission === "denied") {
    desktopNote = "Permission was withdrawn in the browser; nothing is shown until it is allowed again.";
  }

  return (
    <>
      <ToggleRow
        title="Tab badge"
        help="The tab title shows how many exceptions the Overview strip lists — “(2) sparkDash” — and the icon gets a red (critical) or amber dot. This browser only; saved immediately."
        checked={prefs.tabBadge}
        onChange={(v) => setPrefs({ ...prefs, tabBadge: v })}
      />
      <ToggleRow
        title="Desktop notifications"
        help={
          <>
            A notification when an exception becomes active, while this page is open. This browser only; saved immediately.
            {desktopNote && (
              <span className="set-row__note" role="note">
                {desktopNote}
              </span>
            )}
          </>
        }
        checked={prefs.desktop && support === "ok"}
        disabled={support !== "ok" || asking}
        onChange={() => void toggleDesktop()}
      />
    </>
  );
}
