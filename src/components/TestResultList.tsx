import type { SparkTestResponse } from "../api/types";
import { useTranslation } from "react-i18next";
import "../styles/dialogs.css";

/** Connection-test results as a status list (ssh, hardware, LLM, ...). */
export function TestResultList({ result }: { result: SparkTestResponse }) {
  const { t } = useTranslation("devices");
  return (
    <div className="test-list" role="status">
      <p className={result.ok ? "test-list__head is-ok" : "test-list__head is-bad"}>
        {result.ok ? t("test.allPassed") : t("test.someFailed")}
      </p>
      {result.capabilities.map((c) => (
        <div key={c.id} className="test-list__row">
          <i
            className={`sdot${c.status === "fail" ? " sdot--bad" : c.status === "skipped" ? " sdot--off" : ""}`}
            aria-hidden
          />
          <span className="test-list__label">{c.label}</span>
          <span className="test-list__state">
            {c.status === "pass" ? t("test.pass") : c.status === "fail" ? t("test.fail") : t("test.skipped")}
          </span>
          {(c.message || c.recovery) && (
            <span className="test-list__msg">
              {c.message}
              {c.recovery ? ` ${c.recovery}` : ""}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}
