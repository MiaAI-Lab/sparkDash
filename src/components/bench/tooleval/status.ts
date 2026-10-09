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
      return watching ? "Running" : "Running (not watched)";
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    case "stopped":
      return "Stopped";
    case "gone":
      return "Gone";
    default:
      return status;
  }
}
