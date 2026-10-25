import type { SparkConfig } from "../api/types";

/** Short noun for a unit kind, matching the "Spark/GPU Host" wording used elsewhere. */
export function deviceKindNoun(kind: SparkConfig["kind"]): "Spark" | "GPU Host" | "Mac" {
  return kind === "host" ? "GPU Host" : kind === "mac" ? "Mac" : "Spark";
}

/** The choices in the Unit type select. */
export type UnitType = "spark" | "host" | "mac" | "windows";

export const UNIT_TYPE_OPTIONS: { value: UnitType; label: string }[] = [
  { value: "spark", label: "NVIDIA DGX Spark" },
  { value: "host", label: "Dedicated GPU host (Linux, nvidia-smi, not a Spark)" },
  { value: "mac", label: "Apple Silicon Mac (macOS over SSH, or via the Mac node agent)" },
  { value: "windows", label: "Windows PC (NVIDIA GPU or AMD Strix Halo)" },
];

export function unitTypeOf(config: Pick<SparkConfig, "kind" | "platform">): UnitType {
  if (config.platform === "windows") return "windows";
  if (config.kind === "mac") return "mac";
  return config.kind === "host" ? "host" : "spark";
}

/** Config fields to set when the Unit type select changes. */
export function unitTypePatch(type: UnitType, current: Pick<SparkConfig, "platform">): Partial<SparkConfig> {
  if (type === "windows") return { kind: "host", platform: "windows", isLocal: false };
  // Mac units are read by the macOS collectors and the optional Mac node agent; always remote.
  if (type === "mac") return { kind: "mac", isLocal: false };
  // Keep a macOS platform set through the API; everything else is plain Linux.
  const platform = current.platform === "darwin" ? "darwin" : "linux";
  return { kind: type, platform };
}

/** Label for the final "add" button in the Add dialog. */
export function addDeviceLabel(kind: SparkConfig["kind"]): string {
  return `Add ${deviceKindNoun(kind)}`;
}

/** Title for the Edit dialog. */
export function editDeviceTitle(kind: SparkConfig["kind"]): string {
  return `Edit ${deviceKindNoun(kind)}`;
}
