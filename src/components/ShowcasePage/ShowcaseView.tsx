import type { SparkSnapshot } from "../../api/types";
import { useTranslation } from "react-i18next";
import { useBenchSpark } from "../bench/useBenchSpark";
import { SparkChips } from "../bench/SparkChips";
import { isLlmMonitoringEnabled, isWorkerSpark } from "../../api/sparkRole";
import { ServerIcon, TerminalIcon } from "../ui/icons";
import { showcaseUrl } from "../shell/sparkSummary";
import { ShowcasePage } from "./ShowcasePage";

/** The Showcase as a page of the dashboard: pick a Spark, run it here, or pop it out into its own window. */
export function ShowcaseView({ sparks }: { sparks: readonly SparkSnapshot[] }) {
  const { t } = useTranslation("showcase");
  const { spark, select, eligible } = useBenchSpark(sparks);
  const canRun = Boolean(spark && spark.online && isLlmMonitoringEnabled(spark) && !spark.workerNode);
  const runnable = (s: SparkSnapshot) =>
    s.online && !isWorkerSpark(s) && isLlmMonitoringEnabled(s) && Array.isArray(s.metrics.llm) && s.metrics.llm.some((l) => l.available);
  const alternative = eligible.find((s) => s.id !== spark?.id && runnable(s)) ?? null;
  let why: { title: string; body: string } | null = null;
  if (spark && !canRun) {
    if (!spark.online) why = { title: t("view.offlineTitle", { name: spark.name }), body: t("view.offlineBody") };
    else if (isWorkerSpark(spark)) why = { title: t("view.workerTitle", { name: spark.name }), body: t("view.workerBody") };
    else why = { title: t("view.offTitle"), body: t("view.offBody", { name: spark.name }) };
  }
  return (
    <div className="bench-page showcase-view">
      <div className="page-head">
        <div>
          <div className="eyebrow">{t("view.workspace")}</div>
          <h1>{t("text.showcase")}</h1>
          <p className="page-head__sub">{t("view.subtitle")}</p>
        </div>
        <div className="page-head__tools">
          {spark ? (
            <a
              className="btn btn--sm"
              href={showcaseUrl(spark)}
              target="_blank"
              rel="noopener noreferrer"
              title={t("view.openTitle")}
            >
              {t("view.open")}
            </a>
          ) : null}
        </div>
      </div>
      <div className="bench-runon">
        <span className="eyebrow">{t("view.runOn")}</span>
        {eligible.length === 0 ? <span className="bench-runon__none">{t("view.noSparks")}</span> : null}
        <SparkChips sparks={eligible} activeId={spark?.id ?? null} onSelect={select} />
      </div>
      {spark ? (
        canRun ? (
          <ShowcasePage key={spark.id} sparkId={spark.id} embedded />
        ) : (
          <div className="sc-empty" role="status">
            <span className="sc-empty__icon" aria-hidden>
              {spark.online ? <TerminalIcon className="h-6 w-6" /> : <ServerIcon className="h-6 w-6" />}
            </span>
            <h2 className="sc-empty__title">{why?.title}</h2>
            <p className="sc-empty__body">{why?.body}</p>
            {alternative ? (
              <button type="button" className="btn btn--primary" onClick={() => select(alternative.id)}>
                {t("view.runOnNode", { name: alternative.name })}
              </button>
            ) : (
              <p className="sc-empty__hint">{t("view.noReachable")}</p>
            )}
          </div>
        )
      ) : null}
    </div>
  );
}
