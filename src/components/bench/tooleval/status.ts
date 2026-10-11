import { i18next } from "../../../i18n";
import type { ToolEvalRunStatus } from "../../../api/types";

export type StatusTone = "good" | "bad" | "warn" | "acc" | "neutral";

export function statusTone(status: ToolEvalRunStatus): StatusTone {
  switch (status) {
    case "completed":
      return "good";
    case "failed":
      return "bad";
    case "stopped":
    case "gone":
      return "warn";
    case "running":
      return "acc";
    default:
      return "neutral";
  }
}

export function statusLabel(status: ToolEvalRunStatus, watching = true): string {
  switch (status) {
    case "running":
      return watching ? i18next.t("bench.ui.running_73989d", "Running") : i18next.t("bench.ui.runningNotWatched_73f269", "Running (not watched)");
    case "completed":
      return i18next.t("bench.ui.completed_1798b3", "Completed");
    case "failed":
      return i18next.t("bench.ui.failed_09fef5", "Failed");
    case "stopped":
      return i18next.t("bench.ui.stopped_51e911", "Stopped");
    case "gone":
      return i18next.t("bench.ui.gone_149ecf", "Gone");
    default:
      return status;
  }
}
