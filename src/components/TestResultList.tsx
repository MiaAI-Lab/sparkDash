import { useTranslation } from "react-i18next";
import type { SparkTestResponse } from "../api/types";
import { localizedServerMessage } from "../i18n/messages";
import "../styles/dialogs.css";

/** Connection-test results as a status list (ssh, hardware, LLM, ...). */
export function TestResultList({ result }: { result: SparkTestResponse }) {
  const { t } = useTranslation();
  return (
    <div className="test-list" role="status">
      <p className={result.ok ? "test-list__head is-ok" : "test-list__head is-bad"}>
        {result.ok
          ? t("spark.test.allPassed", "All required capabilities passed.")
          : t("spark.test.someFailed", "One or more required capabilities failed.")}
      </p>
      {result.capabilities.map((c) => (
        <div key={c.id} className="test-list__row">
          <i
            className={`sdot${c.status === "fail" ? " sdot--bad" : c.status === "skipped" ? " sdot--off" : ""}`}
            aria-hidden
          />
          <span className="test-list__label">{localizedServerMessage(c.i18n?.label, c.label)}</span>
          <span className="test-list__state">
            {c.status === "pass"
              ? t("spark.test.statePass", "ok")
              : c.status === "fail"
                ? t("spark.test.stateFail", "failed")
                : t("spark.test.stateSkipped", "skipped")}
          </span>
          {(c.message || c.recovery) && (
            <span className="test-list__msg">
              {localizedServerMessage(c.i18n?.message, c.message ?? "")}
              {c.recovery ? ` ${localizedServerMessage(c.i18n?.recovery, c.recovery)}` : ""}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}
