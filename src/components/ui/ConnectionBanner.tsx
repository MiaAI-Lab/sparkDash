import { useTranslation } from "react-i18next";

type ConnectionBannerProps = {
  connected: boolean;
  lastValidSnapshotAt: number | null;
  snapshotError: string | null;
  now: number;
  stale: boolean;
};

function formatAge(ms: number, t: (key: "connection.ageSeconds" | "connection.ageMinutes", options: { seconds: number; minutes?: number }) => string) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return t("connection.ageSeconds", { seconds });
  const minutes = Math.floor(seconds / 60);
  return t("connection.ageMinutes", { minutes, seconds: seconds % 60 });
}

export function ConnectionBanner({
  connected,
  lastValidSnapshotAt,
  snapshotError,
  now,
  stale,
}: ConnectionBannerProps) {
  const { t } = useTranslation("shell");
  if (connected && !snapshotError && !stale) return null;

  let message = t("connection.connecting");
  if (snapshotError) message = snapshotError;
  else if (lastValidSnapshotAt != null) {
    const age = formatAge(now - lastValidSnapshotAt, t);
    message = connected
      ? t("connection.staleWithAge", { age })
      : t("connection.disconnectedWithAge", { age });
  } else if (!connected) {
    message = t("connection.waitingForFirstUpdate");
  }

  const announced = snapshotError
    ? t("connection.dataError")
    : connected
      ? t("connection.stale")
      : t("connection.disconnected");

  return (
    <div className="connection-banner">
      <span className="connection-banner-dot" aria-hidden="true" />
      <span className="sr-only" role="status" aria-live="polite">
        {announced}
      </span>
      <span aria-hidden="true">{message}</span>
    </div>
  );
}
