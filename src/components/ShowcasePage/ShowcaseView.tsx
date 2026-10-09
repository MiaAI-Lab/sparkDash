import type { SparkSnapshot } from "../../api/types";
import { useBenchSpark } from "../bench/useBenchSpark";
import { SparkChips } from "../bench/SparkChips";
import { isLlmMonitoringEnabled, isWorkerSpark } from "../../api/sparkRole";
import { ServerIcon, TerminalIcon } from "../ui/icons";
import { showcaseUrl } from "../shell/sparkSummary";
import { ShowcasePage } from "./ShowcasePage";

/** The Showcase as a page of the dashboard: pick a Spark, run it here, or pop it out into its own window. */
export function ShowcaseView({ sparks }: { sparks: readonly SparkSnapshot[] }) {
  const { spark, select, eligible } = useBenchSpark(sparks);
  const canRun = Boolean(spark && spark.online && isLlmMonitoringEnabled(spark) && !spark.workerNode);
  const runnable = (s: SparkSnapshot) =>
    s.online && !isWorkerSpark(s) && isLlmMonitoringEnabled(s) && Array.isArray(s.metrics.llm) && s.metrics.llm.some((l) => l.available);
  const alternative = eligible.find((s) => s.id !== spark?.id && runnable(s)) ?? null;
  let why: { title: string; body: string } | null = null;
  if (spark && !canRun) {
    if (!spark.online) why = { title: `${spark.name} is offline`, body: "Bring it back online, or run the showcase on another Spark." };
    else if (isWorkerSpark(spark)) why = { title: `${spark.name} is a worker`, body: "Workers share a model that the head Spark serves, so there is nothing to stream from this one. Run the showcase on the head instead." };
    else why = { title: "Showcase is off for this Spark", body: `LLM monitoring is turned off for ${spark.name}, so there is no model to talk to.` };
  }
  return (
    <div className="bench-page showcase-view">
      <div className="page-head">
        <div>
          <div className="eyebrow">Workspace</div>
          <h1>Showcase</h1>
          <p className="page-head__sub">Run prompts on several terminals at once and watch your model stream.</p>
        </div>
        <div className="page-head__tools">
          {spark ? (
            <a
              className="btn btn--sm"
              href={showcaseUrl(spark)}
              target="_blank"
              rel="noopener noreferrer"
              title="Open the showcase in its own full-screen window"
            >
              Open in new window ↗
            </a>
          ) : null}
        </div>
      </div>
      <div className="bench-runon">
        <span className="eyebrow">Run on</span>
        {eligible.length === 0 ? <span className="bench-runon__none">No Sparks available</span> : null}
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
                Run on {alternative.name}
              </button>
            ) : (
              <p className="sc-empty__hint">No Spark with a reachable model is online right now.</p>
            )}
          </div>
        )
      ) : null}
    </div>
  );
}
