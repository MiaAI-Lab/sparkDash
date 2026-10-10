import type { SparkConfig } from "../api/types";
import { i18next } from "../i18n";

/** Short noun for a unit kind, matching the "Spark/GPU Host" wording used elsewhere. */
export function deviceKindNoun(kind: SparkConfig["kind"]): string {
  return kind === "host"
    ? i18next.t("spark.kind.host", "GPU Host")
    : i18next.t("spark.kind.spark", "Spark");
}

/** Label for the final "add" button in the Add dialog. */
export function addDeviceLabel(kind: SparkConfig["kind"]): string {
  return i18next.t("spark.addDevice", "Add {noun}", { noun: deviceKindNoun(kind) });
}

/** Title for the Edit dialog. */
export function editDeviceTitle(kind: SparkConfig["kind"]): string {
  return i18next.t("spark.editDevice", "Edit {noun}", { noun: deviceKindNoun(kind) });
}
