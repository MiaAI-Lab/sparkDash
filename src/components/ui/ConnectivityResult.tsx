import { useTranslation } from "react-i18next";
import { i18next } from "../../i18n";
import type { SparkTestResponse } from "../../api/types";
import { localizedServerMessage } from "../../i18n/messages";

const t = i18next.t.bind(i18next);

export function ConnectivityResult({ result }: { result: SparkTestResponse }) {
  useTranslation();
  return (
    <div
      className={`mt-3 rounded px-3 py-2 text-xs ${result.ok ? "bg-success/20" : "bg-danger/20"}`}
      role="status"
    >
      <p className={result.ok ? "text-success" : "text-danger"}>
        {result.ok ? t("ui.text.allRequiredCapabilitiesPassed", "All required capabilities passed.") : t("ui.text.oneOrMoreRequiredCapabilitiesFailed", "One or more required capabilities failed.")}
      </p>
      <ul className="mt-1 space-y-1">
        {result.capabilities.map((capability) => (
          <li key={capability.id} className={capability.status === "fail" ? "text-danger" : "text-muted"}>
            <strong>{localizedServerMessage(capability.i18n?.label, capability.label)}:</strong>{" "}
            {capability.status === "pass" ? t("ui.text.pass", "Pass") : capability.status === "fail" ? t("ui.text.fail", "Fail") : t("ui.text.skipped", "Skipped")}
            {capability.message ? ` — ${localizedServerMessage(capability.i18n?.message, capability.message)}` : ""}
            {capability.recovery ? ` ${localizedServerMessage(capability.i18n?.recovery, capability.recovery)}` : ""}
          </li>
        ))}
      </ul>
    </div>
  );
}
