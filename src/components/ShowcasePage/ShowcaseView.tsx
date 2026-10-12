import { useTranslation } from "react-i18next";
import { i18next } from "../../i18n";
import type { SparkSnapshot } from "../../api/types";
import { useBenchSpark } from "../bench/useBenchSpark";
import { SparkChips } from "../bench/SparkChips";
import { isLlmMonitoringEnabled, isWorkerSpark } from "../../api/sparkRole";
import { ServerIcon, TerminalIcon } from "../ui/icons";
import { showcaseUrl } from "../shell/sparkSummary";
import { ShowcasePage } from "./ShowcasePage";

const t = i18next.t.bind(i18next);

/** The Showcase as a page of the dashboard: pick a Spark, run it here, or pop it out into its own window. */
export function ShowcaseView({ sparks }: { sparks: readonly SparkSnapshot[] }) {
  useTranslation();
  const { spark, select, eligible } = useBenchSpark(sparks);
  const canRun = Boolean(spark && spark.online && isLlmMonitoringEnabled(spark) && !spark.workerNode);
  const runnable = (s: SparkSnapshot) =>
    s.online && !isWorkerSpark(s) && isLlmMonitoringEnabled(s) && Array.isArray(s.metrics.llm) && s.metrics.llm.some((l) => l.available);
  const alternative = eligible.find((s) => s.id !== spark?.id && runnable(s)) ?? null;
  let why: { title: string; body: string } | null = null;
  if (spark && !canRun) {
    if (!spark.online) why = { title: t("showcase.text.0IsOffline", "{value0} is offline", { value0: spark.name }), body: t("showcase.text.bringItBackOnlineOrRunTheShowcaseOnAnotherSpark", "Bring it back online, or run the showcase on another Spark.") };
    else if (isWorkerSpark(spark)) why = { title: t("showcase.text.0IsAWorker", "{value0} is a worker", { value0: spark.name }), body: t("showcase.text.workersShareAModelThatTheHeadSparkServesSoThereIsNothingToStreamFromThisOneRunTh", "Workers share a model that the head Spark serves, so there is nothing to stream from this one. Run the showcase on the head instead.") };
    else why = { title: t("showcase.text.showcaseIsOffForThisSpark", "Showcase is off for this Spark"), body: t("showcase.text.llmMonitoringIsTurnedOffFor0SoThereIsNoModelToTalkTo", "LLM monitoring is turned off for {value0}, so there is no model to talk to.", { value0: spark.name }) };
  }
  return (
    <div className="bench-page showcase-view">
      <div className="page-head">
        <div>
          <div className="eyebrow">{t("showcase.text.workspace", "Workspace")}</div>
          <h1>{t("showcase.text.showcase", "Showcase")}</h1>
          <p className="page-head__sub">{t("showcase.text.runPromptsOnSeveralTerminalsAtOnceAndWatchYourModelStream", "Run prompts on several terminals at once and watch your model stream.")}</p>
        </div>
        <div className="page-head__tools">
          {spark ? (
            <a
              className="btn btn--sm"
              href={showcaseUrl(spark)}
              target="_blank"
              rel="noopener noreferrer"
              title={t("showcase.text.openTheShowcaseInItsOwnFullScreenWindow", "Open the showcase in its own full-screen window")}
            > {t("showcase.text.openInNewWindow", "Open in new window ↗")} </a>
          ) : null}
        </div>
      </div>
      <div className="bench-runon">
        <span className="eyebrow">{t("showcase.text.runOn", "Run on")}</span>
        {eligible.length === 0 ? <span className="bench-runon__none">{t("showcase.text.noSparksAvailable", "No Sparks available")}</span> : null}
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
              <button type="button" className="btn btn--primary" onClick={() => select(alternative.id)}> {t("showcase.runOnNode", "Run on {name}", { name: alternative.name })}
              </button>
            ) : (
              <p className="sc-empty__hint">{t("showcase.text.noSparkWithAReachableModelIsOnlineRightNow", "No Spark with a reachable model is online right now.")}</p>
            )}
          </div>
        )
      ) : null}
    </div>
  );
}
