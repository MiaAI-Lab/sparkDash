import { useState } from "react";
import { useTranslation } from "react-i18next";
import { notificationSupport, useBrowserAlertPrefs } from "../hooks/useBrowserAlerts";
import { ToggleRow } from "./SettingRows";

/**
 * Settings → Tab badge / Desktop notifications. Per browser (localStorage),
 * saved on click — not part of the server settings the dialog's Save writes.
 * Both count every fleet alert the Overview exceptions strip knows of, even
 * while "Show active fleet exceptions" is off and the strip shows throttling only.
 */
export function BrowserAlertsSettings() {
  const { t } = useTranslation("settings");
  const [prefs, setPrefs] = useBrowserAlertPrefs();
  const support = notificationSupport();
  const [noteId, setNoteId] = useState<"blocked" | "refused" | null>(null);
  const [asking, setAsking] = useState(false);
  const permission = support === "ok" ? Notification.permission : null;

  const toggleDesktop = async () => {
    if (prefs.desktop) {
      setPrefs({ ...prefs, desktop: false });
      setNoteId(null);
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
        setNoteId(null);
      } else {
        setNoteId("blocked");
      }
    } catch {
      setNoteId("refused");
    } finally {
      setAsking(false);
    }
  };

  let desktopNoteId: "blocked" | "refused" | "insecure" | "unsupported" | "withdrawn" | null = noteId;
  if (!desktopNoteId && support === "insecure") {
    desktopNoteId = "insecure";
  } else if (!desktopNoteId && support === "unsupported") {
    desktopNoteId = "unsupported";
  } else if (!desktopNoteId && support === "ok" && prefs.desktop && permission === "denied") {
    desktopNoteId = "withdrawn";
  }

  return (
    <>
      <ToggleRow
        title={t("browserAlerts.tabBadge.title")}
        help={t("browserAlerts.tabBadge.help")}
        checked={prefs.tabBadge}
        onChange={(v) => setPrefs({ ...prefs, tabBadge: v })}
      />
      <ToggleRow
        title={t("browserAlerts.desktop.title")}
        help={
          <>
            {t("browserAlerts.desktop.help")}
            {desktopNoteId && (
              <span className="set-row__note" role="note">
                {desktopNoteId === "blocked" && t("browserAlerts.desktop.blocked")}
                {desktopNoteId === "refused" && t("browserAlerts.desktop.refused")}
                {desktopNoteId === "insecure" && t("browserAlerts.desktop.insecure")}
                {desktopNoteId === "unsupported" && t("browserAlerts.desktop.unsupported")}
                {desktopNoteId === "withdrawn" && t("browserAlerts.desktop.withdrawn")}
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
