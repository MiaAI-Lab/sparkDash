import type { ToolEvalRunStatus } from "../../../api/types";
import { message, type ToolEvalPresentation } from "./presentation";

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

export function statusLabel(status: ToolEvalRunStatus, watching = true, presentation?: ToolEvalPresentation): string {
  switch (status) {
    case "running":
      return watching ? message(presentation, "status.running", "Running") : message(presentation, "status.unwatched", "Running (not watched)");
    case "completed":
      return message(presentation, "status.completed", "Completed");
    case "failed":
      return message(presentation, "status.failed", "Failed");
    case "stopped":
      return message(presentation, "status.stopped", "Stopped");
    case "gone":
      return message(presentation, "status.gone", "Gone");
    default:
      return status;
  }
}
