import { useCallback, useEffect, useState } from "react";
import type { LauncherRunState, LlmLauncher, SparkSnapshot } from "../../api/types";
import { fetchLaunchers, runLauncher } from "../../api/client";
import { LlmLauncherDialog } from "../SparkPage/LlmLauncherDialog";
import { PlusIcon } from "../ui/icons";

const REFRESH_MS = 30_000;
const MAX_ROWS = 3;

/**
 * Fills an idle Spark card: start one of the models registered for this Spark
 * (the Models panel's start.sh launchers) or register a first one.
 */
export function ModelLauncher({
  spark,
  onOpen,
  busy = null,
}: {
  spark: SparkSnapshot;
  onOpen?: (id: string) => void;
  /** Set when the GPU is in use although nothing serves yet (a model is probably loading). */
  busy?: string | null;
}) {
  const sparkId = spark.id;
  const [launchers, setLaunchers] = useState<LlmLauncher[] | null>(null);
  const [statuses, setStatuses] = useState<Record<string, LauncherRunState>>({});
  const [failed, setFailed] = useState(false);
  const [starting, setStarting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [override, setOverride] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const res = await fetchLaunchers(sparkId, true);
      setLaunchers(res.launchers);
      setStatuses(res.statuses ?? {});
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [sparkId]);

  useEffect(() => {
    void refresh();
    const t = window.setInterval(() => {
      if (!document.hidden) void refresh();
    }, REFRESH_MS);
    return () => window.clearInterval(t);
  }, [refresh]);

  async function start(l: LlmLauncher) {
    setError(null);
    setStarting(l.id);
    try {
      await runLauncher(sparkId, l.id, "start");
      setStatuses((s) => ({ ...s, [l.id]: "running" }));
      window.setTimeout(() => void refresh(), 2500);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setStarting(null);
    }
  }

  const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();
  const loading = launchers?.find((l) => statuses[l.id] === "running") ?? null;
  const shown = launchers?.slice(0, MAX_ROWS) ?? [];
  const more = (launchers?.length ?? 0) - shown.length;

  let body;
  if (launchers == null) {
    body = <div className="ov-launch__hint">{failed ? "Models unavailable" : "Looking for models…"}</div>;
  } else if (loading) {
    body = (
      <>
        <div className="ov-launch__title">
          <span className="ov-launch__spin" aria-hidden />
          Loading {loading.name}…
        </div>
        <div className="ov-launch__hint">The start script is running; the model appears here once it serves.</div>
        {onOpen ? (
          <button type="button" className="btn btn--sm" onClick={(e) => { stop(e); onOpen(sparkId); }}>
            View output
          </button>
        ) : null}
      </>
    );
  } else if (busy && !override) {
    body = (
      <>
        <div className="ov-launch__title">
          <span className="ov-launch__spin" aria-hidden />
          Something is loading
        </div>
        <div className="ov-launch__hint">{busy}. Starting another model now could run out of memory.</div>
        <div className="ov-launch__more">
          {onOpen ? (
            <button type="button" className="btn btn--sm" onClick={(e) => { stop(e); onOpen(sparkId); }}>
              Open Spark
            </button>
          ) : null}
          <button type="button" className="btn btn--sm btn--ghost" onClick={(e) => { stop(e); setOverride(true); }}>
            Start anyway…
          </button>
        </div>
      </>
    );
  } else if (launchers.length === 0) {
    body = (
      <>
        <div className="ov-launch__title">No model loaded</div>
        <div className="ov-launch__hint">Add a model folder (start.sh / stop.sh) to start it from here.</div>
        <button type="button" className="btn btn--sm btn--primary" onClick={(e) => { stop(e); setAdding(true); }}>
          <PlusIcon className="h-3.5 w-3.5" />
          Add a model
        </button>
      </>
    );
  } else {
    body = (
      <>
        <div className="ov-launch__title">{busy ? "GPU is busy · start anyway?" : "No model loaded · start one"}</div>
        {busy ? <div className="ov-launch__hint">{busy}.</div> : null}
        <ul className="ov-launch__list">
          {shown.map((l) => (
            <li key={l.id}>
              <span className="ov-launch__name" title={l.notes || l.dir}>{l.name}</span>
              {l.port != null ? <span className="ov-launch__port mono">:{l.port}</span> : null}
              <button
                type="button"
                className="btn btn--sm btn--primary"
                disabled={starting != null}
                onClick={(e) => { stop(e); void start(l); }}
              >
                {starting === l.id ? "Starting…" : "Start"}
              </button>
            </li>
          ))}
        </ul>
        <div className="ov-launch__more">
          {more > 0 && onOpen ? (
            <button type="button" className="btn btn--sm btn--ghost" onClick={(e) => { stop(e); onOpen(sparkId); }}>
              +{more} more
            </button>
          ) : null}
          <button type="button" className="btn btn--sm btn--ghost" onClick={(e) => { stop(e); setAdding(true); }}>
            <PlusIcon className="h-3.5 w-3.5" />
            Add model
          </button>
        </div>
      </>
    );
  }

  return (
    <div className="ov-launch" onClick={stop} onKeyDown={stop}>
      {body}
      {error ? <div className="ov-launch__err" role="alert">{error}</div> : null}
      <LlmLauncherDialog
        open={adding}
        sparkId={sparkId}
        sparkName={spark.name}
        onClose={() => setAdding(false)}
        onSaved={() => {
          setAdding(false);
          void refresh();
        }}
      />
    </div>
  );
}
