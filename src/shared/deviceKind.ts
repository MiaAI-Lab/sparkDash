import type { SparkConfig } from "../api/types";
import { i18next } from "../i18n";

/** Short noun for a unit kind, matching the "Spark/GPU Host" wording used elsewhere. */
export function deviceKindNoun(kind: SparkConfig["kind"]): string {
  return kind === "host"
    ? i18next.t("spark.kind.host", "GPU Host")
    : i18next.t("spark.kind.spark", "Spark");
}

/** The choices in the Unit type select. */
export type UnitType = "spark" | "host" | "windows";

export const UNIT_TYPE_OPTIONS: { value: UnitType; label: string }[] = [
  { value: "spark", label: "NVIDIA DGX Spark" },
  { value: "host", label: "Dedicated GPU host (Linux, nvidia-smi, not a Spark)" },
  { value: "windows", label: "Windows PC with an NVIDIA GPU (OpenSSH, nvidia-smi)" },
];

export function unitTypeOf(config: Pick<SparkConfig, "kind" | "platform">): UnitType {
  if (config.platform === "windows") return "windows";
  return config.kind === "host" ? "host" : "spark";
}

/** Config fields to set when the Unit type select changes. */
export function unitTypePatch(type: UnitType, current: Pick<SparkConfig, "platform">): Partial<SparkConfig> {
  if (type === "windows") return { kind: "host", platform: "windows", isLocal: false };
  // Keep a macOS platform set through the API; everything else is plain Linux.
  const platform = current.platform === "darwin" ? "darwin" : "linux";
  return { kind: type, platform };
}

/** Label for the final "add" button in the Add dialog. */
export function addDeviceLabel(kind: SparkConfig["kind"]): string {
  return i18next.t("spark.addDevice", "Add {noun}", { noun: deviceKindNoun(kind) });
}

/** Title for the Edit dialog. */
export function editDeviceTitle(kind: SparkConfig["kind"]): string {
  return i18next.t("spark.editDevice", "Edit {noun}", { noun: deviceKindNoun(kind) });
}
