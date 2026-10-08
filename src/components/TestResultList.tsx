import type { SparkTestResponse } from "../api/types";
import "../styles/dialogs.css";

/** Connection-test results as a status list (ssh, hardware, LLM, ...). */
export function TestResultList({ result }: { result: SparkTestResponse }) {
  return (
    <div className="test-list" role="status">
      <p className={result.ok ? "test-list__head is-ok" : "test-list__head is-bad"}>
        {result.ok ? "All required capabilities passed." : "One or more required capabilities failed."}
      </p>
      {result.capabilities.map((c) => (
        <div key={c.id} className="test-list__row">
          <i
            className={`sdot${c.status === "fail" ? " sdot--bad" : c.status === "skipped" ? " sdot--off" : ""}`}
            aria-hidden
          />
          <span className="test-list__label">{c.label}</span>
          <span className="test-list__state">
            {c.status === "pass" ? "ok" : c.status === "fail" ? "failed" : "skipped"}
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
