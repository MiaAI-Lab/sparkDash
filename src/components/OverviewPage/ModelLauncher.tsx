import { useCallback, useEffect, useRef, useState } from "react";
import type { LauncherRunState, LlmLauncher, SparkSnapshot } from "../../api/types";
import { runLauncher } from "../../api/client";
import { fetchLaunchersCached, getCachedLaunchers, invalidateLaunchers, patchCachedStatus } from "../../hooks/launcherCache";
import { LlmLauncherDialog } from "../SparkPage/LlmLauncherDialog";
import { formatMb } from "../../shared/formatBytes";
import { PlusIcon } from "../ui/icons";
import { useTranslation } from "react-i18next";

const REFRESH_MS = 30_000;
/** Status re-check after a Start, once the script has had time to bring the engine up. */
const AFTER_START_MS = 2_500;
const MAX_ROWS = 3;

/**
 * Fills an idle Spark card: start one of the models registered for this Spark
 * (the Models panel's start.sh launchers) or register a first one.
 *
 * The list and statuses come from the shared launcher cache (one SSH-backed request per Spark
 * at most every few seconds, however many cards or panels ask), so a card that remounts
 * when the LLM flaps shows the last known state at once instead of probing again.
 */
export function ModelLauncher({
  spark,
  onOpen,
  busy = null,
  busyHolders = false,
  freeMb = null,
  lowFreeMb = 0,
}: {
  spark: SparkSnapshot;
  onOpen?: (id: string) => void;
  /** Set when the GPU is in use although nothing serves yet (a model is probably loading). */
  busy?: string | null;
  /** The busy text names the processes holding the GPU, so it is not a model that is starting. */
  busyHolders?: boolean;
  /** Free memory in MB; null when unknown. */
  freeMb?: number | null;
  /** Below this much free memory, "Start anyway" asks a second time. */
  lowFreeMb?: number;
}) {
  const { t } = useTranslation("overview");
  const sparkId = spark.id;
  const initial = getCachedLaunchers(sparkId);
  const [launchers, setLaunchers] = useState<LlmLauncher[] | null>(initial?.launchers ?? null);
  const [statuses, setStatuses] = useState<Record<string, LauncherRunState>>(initial?.statuses ?? {});
  const [failed, setFailed] = useState(false);
  const [starting, setStarting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [override, setOverride] = useState(false);
  const [confirmLow, setConfirmLow] = useState(false);
  const lowMemory = freeMb != null && freeMb < lowFreeMb;
  /** Ignores results that arrive after unmount or a Spark switch. */
  const aliveRef = useRef(true);
  const afterStartTimer = useRef<number | undefined>(undefined);

  const refresh = useCallback(
    async (force = false) => {
      try {
        const res = await fetchLaunchersCached(sparkId, { force });
        if (!aliveRef.current) return;
        setLaunchers(res.launchers);
        setStatuses(res.statuses ?? {});
        setFailed(false);
        setError(null);
      } catch {
        if (aliveRef.current) setFailed(true);
      }
    },
    [sparkId]
  );

  useEffect(() => {
    aliveRef.current = true;
    void refresh();
    const t = window.setInterval(() => {
      if (!document.hidden) void refresh();
    }, REFRESH_MS);
    const onVisible = () => {
      if (!document.hidden) void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      aliveRef.current = false;
      window.clearInterval(t);
      window.clearTimeout(afterStartTimer.current);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refresh]);

  async function start(l: LlmLauncher) {
    setError(null);
    setStarting(l.id);
    try {
      await runLauncher(sparkId, l.id, "start");
      if (!aliveRef.current) return;
      // Not followed from here (the Spark page shows the output); just keep the status honest.
      patchCachedStatus(sparkId, l.id, "running");
      setStatuses((s) => ({ ...s, [l.id]: "running" }));
      invalidateLaunchers(sparkId);
      window.clearTimeout(afterStartTimer.current);
      afterStartTimer.current = window.setTimeout(() => void refresh(true), AFTER_START_MS);
    } catch (e) {
      if (aliveRef.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (aliveRef.current) setStarting(null);
    }
  }

  const loading = launchers?.find((l) => statuses[l.id] === "running") ?? null;
  const shown = launchers?.slice(0, MAX_ROWS) ?? [];
  const more = (launchers?.length ?? 0) - shown.length;

  let body;
  if (launchers == null) {
    // Launcher discovery failing says nothing about the GPU. Keep the activity the
    // collector did supply, so a working unit whose launcher list cannot be read is
    // not presented as having nothing on it. No cause is claimed for the activity.
    body = (
      <div className="ov-launch__hint">
        {failed ? t("launcher.modelsUnavailable") : t("launcher.lookingForModels")}
        {failed && busy ? ` · ${busy}.` : ""}
      </div>
    );
  } else if (loading) {
    body = (
      <>
        <div className="ov-launch__title">
          <span className="ov-launch__spin" aria-hidden />
          {t("launcher.loading", { name: loading.name })}
        </div>
        <div className="ov-launch__hint">{t("launcher.startScriptRunning")}</div>
        {onOpen ? (
          <button type="button" className="btn btn--sm" onClick={() => onOpen(sparkId)}>
            {t("launcher.viewOutput")}
          </button>
        ) : null}
      </>
    );
  } else if (busy && !override) {
    body = (
      <>
        <div className="ov-launch__title">
          {busyHolders ? null : <span className="ov-launch__spin" aria-hidden />}
          {busyHolders ? t("launcher.gpuInUse") : t("launcher.somethingLoading")}
        </div>
        <div className="ov-launch__hint">
          {busy}.{" "}
          {busyHolders
            ? t("launcher.addLlmPort")
            : t("launcher.startCouldRunOut")}
        </div>
        {confirmLow ? (
          <div className="ov-launch__err" role="alert">
            {t("launcher.lowMemoryWarning", { free: formatMb(freeMb ?? 0) })}
          </div>
        ) : null}
        <div className="ov-launch__more">
          {onOpen ? (
            <button type="button" className="btn btn--sm" onClick={() => onOpen(sparkId)}>
              {t("launcher.openSpark")}
            </button>
          ) : null}
          <button
            type="button"
            className="btn btn--sm btn--ghost"
            onClick={() => {
              if (lowMemory && !confirmLow) setConfirmLow(true);
              else setOverride(true);
            }}
          >
            {confirmLow ? t("launcher.confirmStartAnyway") : t("launcher.startAnyway")}
          </button>
        </div>
      </>
    );
  } else if (launchers.length === 0) {
    body = (
      <>
        <div className="ov-launch__title">{t("launcher.noModelLoaded")}</div>
        <div className="ov-launch__hint">{t("launcher.addModelFolder")}</div>
        <button type="button" className="btn btn--sm btn--primary" onClick={() => setAdding(true)}>
          <PlusIcon className="h-3.5 w-3.5" />
          {t("launcher.addModel")}
        </button>
      </>
    );
  } else {
    body = (
      <>
        <div className="ov-launch__title">{busy ? t("launcher.gpuBusyStartAnyway") : t("launcher.noModelStartOne")}</div>
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
                onClick={() => void start(l)}
              >
                {starting === l.id ? t("launcher.starting") : t("launcher.start")}
              </button>
            </li>
          ))}
        </ul>
        <div className="ov-launch__more">
          {more > 0 && onOpen ? (
            <button type="button" className="btn btn--sm btn--ghost" onClick={() => onOpen(sparkId)}>
              {t("launcher.more", { count: more })}
            </button>
          ) : null}
          <button type="button" className="btn btn--sm btn--ghost" onClick={() => setAdding(true)}>
            <PlusIcon className="h-3.5 w-3.5" />
            {t("launcher.addModel")}
          </button>
        </div>
      </>
    );
  }

  // No stopPropagation here: the card is not itself clickable (its name is the link), and
  // swallowing key events would break the global Ctrl+K / Ctrl+B shortcuts and Escape in the dialog.
  return (
    <>
      <div className="ov-launch">
        {body}
        {error ? <div className="ov-launch__err" role="alert">{error}</div> : null}
      </div>
      <LlmLauncherDialog
        open={adding}
        sparkId={sparkId}
        sparkName={spark.name}
        onClose={() => setAdding(false)}
        onSaved={() => {
          setAdding(false);
          invalidateLaunchers(sparkId);
          void refresh(true);
        }}
      />
    </>
  );
}
