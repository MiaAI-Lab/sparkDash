import { useTranslation } from "react-i18next";
import { i18next } from "../../i18n";
import { localizedServerText } from "../../i18n/messages";

const t = i18next.t.bind(i18next);
type ConnectionBannerProps = {
  connected: boolean;
  lastValidSnapshotAt: number | null;
  snapshotError: string | null;
  now: number;
  stale: boolean;
};

function formatAge(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return t("ui.text.0S", "{value0}s", { value0: seconds });
  const minutes = Math.floor(seconds / 60);
  return t("ui.text.0M1S", "{value0}m {value1}s", { value0: minutes, value1: seconds % 60 });
}

export function ConnectionBanner({
  connected,
  lastValidSnapshotAt,
  snapshotError,
  now,
  stale,
}: ConnectionBannerProps) {
  useTranslation();
  if (connected && !snapshotError && !stale) return null;

  let message = t("ui.text.connectingToLiveTelemetry", "Connecting to live telemetry…");
  if (snapshotError) {
    message = snapshotError === "The server sent an invalid telemetry payload."
      ? t("ui.telemetry.invalidPayload", "The server sent an invalid telemetry payload.")
      : snapshotError === "The server sent malformed telemetry data."
        ? t("ui.telemetry.malformed", "The server sent malformed telemetry data.")
        : localizedServerText(snapshotError);
  }
  else if (lastValidSnapshotAt != null) {
    const age = formatAge(now - lastValidSnapshotAt);
    message = connected
      ? t("ui.text.telemetryIsStaleLastValidUpdateWas0Ago", "Telemetry is stale. Last valid update was {value0} ago.", { value0: age })
      : t("ui.text.liveTelemetryDisconnectedShowingDataFrom0Ago", "Live telemetry disconnected. Showing data from {value0} ago.", { value0: age });
  } else if (!connected) {
    message = t("ui.text.liveTelemetryIsDisconnectedWaitingForTheFirstValidUpdate", "Live telemetry is disconnected. Waiting for the first valid update…");
  }

  const announced = snapshotError
    ? t("ui.text.telemetryDataError", "Telemetry data error.")
    : connected
      ? t("ui.text.telemetryIsStale", "Telemetry is stale.")
      : t("ui.text.liveTelemetryIsDisconnected", "Live telemetry is disconnected.");

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
