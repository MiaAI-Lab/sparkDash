// Copyright 2026 Maxrio9. SPDX-License-Identifier: Apache-2.0
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { fetchTrainingProgress, type TrainingProgress, type TrainingStage } from "../../api/trainingClient";
import { activeTimeZone } from "../../shared/timeZone";
import "../../styles/training.css";

/** One read-only page. Figures are displayed as reported; no rate or ETA is inferred. */
export function TrainingPage() {
  const { t, i18n } = useTranslation("training");
  const [snapshot, setSnapshot] = useState<TrainingProgress | null>(null);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let request: AbortController | null = null;
    let disposed = false;
    const refresh = async () => {
      if (request || document.hidden) return;
      const controller = new AbortController();
      request = controller;
      try {
        const next = await fetchTrainingProgress(controller.signal);
        if (disposed || controller.signal.aborted) return;
        setSnapshot(next);
        setFailed(false);
      } catch {
        if (!disposed && !controller.signal.aborted) setFailed(true);
      } finally {
        request = null;
        if (!disposed) setLoading(false);
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 10_000);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
      request?.abort();
    };
  }, []);

  const states: Record<TrainingStage["state"], string> = {
    running: t("states.running"), waiting: t("states.waiting"), complete: t("states.complete"),
    stopped: t("states.stopped"), failed: t("states.failed"), unknown: t("unknown"),
  };
  const groups = [
    { id: "data", label: t("groups.data") },
    { id: "training", label: t("groups.training") },
    { id: "evaluation", label: t("groups.evaluation") },
  ] as const;
  const number = (value: number | null) => value == null ? t("unknown") : new Intl.NumberFormat(i18n.resolvedLanguage, { maximumSignificantDigits: 21 }).format(value);
  const reportedTime = (value: number | null) => value == null ? t("unknown") : new Date(value).toLocaleString(i18n.resolvedLanguage, { timeZone: activeTimeZone() });

  return (
    <div className="training-page">
      <header className="page-head">
        <div>
          <h1>{t("title")}</h1>
          <p className="page-head__sub">{t("subtitle")}</p>
        </div>
      </header>
      {loading ? <p role="status">{t("loading")}</p> : null}
      {failed ? <p className="training-notice" role="alert">{snapshot ? t("errors.stale") : t("errors.load")}</p> : null}
      {snapshot?.error ? <p className="training-notice" role="alert">{t("errors.configuration", { error: snapshot.error })}</p> : null}
      {snapshot && !snapshot.enabled ? <p role="status">{t("disabled")}</p> : null}
      {snapshot?.truncated ? <p className="training-notice" role="status">{t("truncated")}</p> : null}
      {snapshot?.units.filter((unit) => unit.status !== "live" || unit.detail).map((unit) => (
        <p className="training-notice" key={unit.sparkId}>
          <strong>{unit.label}</strong>{" · "}{unit.status === "live" ? t("unit.partial") : unit.status === "unsupported" ? t("unit.unsupported") : t("unit.unavailable")}
          {unit.detail ? <span className="training-diagnostic">{unit.detail}</span> : null}
        </p>
      ))}
      {snapshot?.enabled && snapshot.runs.length === 0 ? <p className="panel training-empty">{t("empty")}</p> : null}
      {snapshot?.enabled ? snapshot.runs.map((run) => (
        <section className="panel training-run" key={run.id}>
          <header className="training-run-head">
            <h2>{run.campaign}</h2>
            {run.model ? <span className="mono">{run.model}</span> : null}
          </header>
          {run.sources.map((source) => {
            const live = !failed && source.status === "live";
            const unit = snapshot.units.find((row) => row.sparkId === source.sparkId);
            return (
              <article className="training-source" key={source.id} data-status={live ? "live" : "stale"}>
                <header>
                  <h3>{source.label}</h3>
                  <span>{unit?.label ?? source.sparkId}</span>
                </header>
                <p className="training-reported" role="status">
                  {live ? t("source.live") : t("source.stale")}{" · "}{t("reportedAt", { time: reportedTime(source.reportedAt) })}
                </p>
                {groups.filter((group) => source.stages[group.id].length > 0).map((group) => (
                  <section className="training-stage-group" key={group.id} aria-label={group.label}>
                    <h4>{group.label}</h4>
                    <ul>
                      {source.stages[group.id].map((stage) => (
                        <li className="training-stage" key={stage.id}>
                          <div className="training-stage-head">
                            <strong>{stage.label}</strong>
                            <span className={`tag ${stage.state === "failed" ? "tag--bad" : stage.state === "complete" ? "tag--good" : ""}`}>
                              {live ? states[stage.state] : t("lastState", { state: states[stage.state] })}
                            </span>
                          </div>
                          <p className="training-count mono">{t("progress", { completed: number(stage.completed), total: number(stage.total) })}{stage.unit ? ` ${stage.unit}` : ""}</p>
                          {live && (stage.state === "running" || stage.state === "waiting") && stage.etaSeconds != null
                            ? <p className="training-eta">{t("reportedEta", { seconds: number(stage.etaSeconds) })}</p> : null}
                          {stage.metrics?.length ? <dl className="training-metrics">{stage.metrics.map((metric, index) => (
                            <div key={index}><dt>{metric.label}</dt><dd className="mono">{typeof metric.value === "number" ? number(metric.value) : metric.value ?? t("unknown")}{metric.unit ? ` ${metric.unit}` : ""}</dd></div>
                          ))}</dl> : null}
                        </li>
                      ))}
                    </ul>
                  </section>
                ))}
              </article>
            );
          })}
        </section>
      )) : null}
    </div>
  );
}
