import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import type { DockerStorage, SparkSnapshot } from "../../api/types";
import { formatBytes } from "../../shared/formatBytes";
import { BoxIcon } from "../ui/icons";
import { Banner } from "./Banner";
import {
  DEFAULT_QUICK_DAYS,
  QUICK_DAYS,
  QUICK_PRESETS,
  RECOMMENDED_PRESETS,
  buildCacheEmpty,
  buildCacheEstimate,
  containersEstimate,
  imagesEstimate,
  isQuickDays,
  joinCleanupItems,
  outcomeSummary,
  pickContainers,
  pickImages,
  planFor,
  presetKind,
  usageUnknownReason,
  type QuickDays,
  type QuickOutcome,
  type QuickPresetId,
  type QuickRule,
  type SizeEstimate,
} from "./dockerQuick";
import { QuickCleanupSheet } from "./QuickCleanupSheet";
import type { AdminAccess } from "./useAdminAccess";

/** The age the time-based rows use, remembered per browser (a convenience: it may not be kept). */
export const QUICK_DAYS_PREF = "sparkdash.storage.dockerQuickDays";

function readDays(): QuickDays {
  try {
    const v = Number(localStorage.getItem(QUICK_DAYS_PREF));
    return isQuickDays(v) ? v : DEFAULT_QUICK_DAYS;
  } catch {
    return DEFAULT_QUICK_DAYS;
  }
}

export function useQuickDays(): [QuickDays, (days: QuickDays) => void] {
  const [days, setDaysState] = useState<QuickDays>(readDays);
  const setDays = useCallback((next: QuickDays) => {
    setDaysState(next);
    try {
      localStorage.setItem(QUICK_DAYS_PREF, String(next));
    } catch {
      /* a preference is a convenience */
    }
  }, []);
  return [days, setDays];
}

/** 1 / 7 / 30 days, as a radio group: arrow keys, Home and End move the choice (roadmap §6.5). */
function DaysControl({ days, onChange, labelledBy }: { days: QuickDays; onChange: (d: QuickDays) => void; labelledBy: string }) {
  const { t } = useTranslation("storage");
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const n = QUICK_DAYS.length;
    const to = e.key === "ArrowRight" || e.key === "ArrowDown" ? (i + 1) % n : e.key === "ArrowLeft" || e.key === "ArrowUp" ? (i - 1 + n) % n : e.key === "Home" ? 0 : e.key === "End" ? n - 1 : -1;
    if (to < 0) return;
    e.preventDefault();
    onChange(QUICK_DAYS[to]);
    refs.current[to]?.focus();
  };
  return (
    <div className="seg st-quick__days" role="radiogroup" aria-labelledby={labelledBy}>
      {QUICK_DAYS.map((d, i) => (
        <button
          key={d}
          ref={(el) => {
            refs.current[i] = el;
          }}
          type="button"
          role="radio"
          aria-checked={d === days}
          tabIndex={d === days ? 0 : -1}
          className={d === days ? "is-on" : undefined}
          onClick={() => onChange(d)}
          onKeyDown={(e) => onKey(e, i)}
        >
          {t("quickCleanup.days", { count: d })}
        </button>
      ))}
    </div>
  );
}

interface Row {
  id: QuickPresetId;
  /** "4 images · up to 12 GB (images share layers)", or why there is nothing. */
  figure: string;
  /** Something to clean. */
  ok: boolean;
  keptBuiltHere: number;
}

function estimateCopy(estimate: SizeEstimate, kind: ReturnType<typeof presetKind>, t: (key: string, options?: Record<string, unknown>) => string): string {
  if (estimate.kind === "none") return "";
  if (estimate.kind === "unknown") return t("quickDetails.sizeUnknown");
  if (estimate.kind === "about") return t("quickDetails.estimateAbout", { bytes: formatBytes(estimate.bytes) });
  const scope = kind === "containers" ? t("quickDetails.everyStoppedContainer") : kind === "images" ? t("quickDetails.everyUnusedImage") : t("quickDetails.allUnusedBuildCache");
  return estimate.basis === "layers"
    ? t("quickDetails.estimateUpToLayers", { bytes: formatBytes(estimate.bytes) })
    : t("quickDetails.estimateUpToDocker", { bytes: formatBytes(estimate.bytes), scope });
}

function presetCopy(id: QuickPresetId, days: QuickDays, t: (key: string, options?: Record<string, unknown>) => string) {
  const day = t("quickCleanup.days", { count: days });
  switch (id) {
    case "old-images": return { title: t("quickDetails.oldImagesTitle", { days: day }), description: t("quickDetails.oldImagesDescription") };
    case "dangling-images": return { title: t("quickDetails.danglingImagesTitle"), description: t("quickDetails.danglingImagesDescription") };
    case "unused-images": return { title: t("quickDetails.unusedImagesTitle"), description: t("quickDetails.unusedImagesDescription") };
    case "old-containers": return { title: t("quickDetails.oldContainersTitle", { days: day }), description: t("quickDetails.oldContainersDescription") };
    case "build-cache": return { title: t("quickDetails.buildCacheTitle", { days: day }), description: t("quickDetails.buildCacheDescription") };
  }
}

function rowOf(id: QuickPresetId, data: DockerStorage, rule: QuickRule, t: (key: string, options?: Record<string, unknown>) => string): Row {
  const kind = presetKind(id);
  if (kind === "build-cache") {
    const empty = buildCacheEmpty(data);
    return { id, figure: empty ? t("quickDetails.nothingToClean") : estimateCopy(buildCacheEstimate(data), kind, t), ok: !empty, keptBuiltHere: 0 };
  }
  const unknown = usageUnknownReason(data);
  if (unknown) return { id, figure: t("quickDetails.usageUnknown"), ok: false, keptBuiltHere: 0 };
  if (kind === "containers") {
    const items = pickContainers(data, rule);
    return { id, figure: items.length === 0 ? t("quickDetails.nothingToClean") : t("quickDetails.figure", { count: t("quickDetails.containers", { count: items.length }), estimate: estimateCopy(containersEstimate(items, data), kind, t) }), ok: items.length > 0, keptBuiltHere: 0 };
  }
  const pick = pickImages(data, id, rule);
  const figure = pick.items.length === 0 ? t("quickDetails.nothingToClean") : t("quickDetails.figure", { count: t("quickDetails.images", { count: pick.items.length }), estimate: estimateCopy(imagesEstimate(pick.items, data), kind, t) });
  return { id, figure, ok: pick.items.length > 0, keptBuiltHere: pick.keptBuiltHere.length };
}

interface QuickCleanupProps {
  spark: SparkSnapshot;
  data: DockerStorage;
  /** Other online Sparks: the sheet can run the same rule there too. */
  peers: SparkSnapshot[];
  access: AdminAccess;
  /** Docker on this Spark is read through sudo, so the clean-up runs the same way. */
  asAdmin: boolean;
  /** Something changed on the Spark: read Docker again and mark the disk numbers stale. */
  onChanged: () => void;
}

/**
 * Quick clean-up: a few presets that reclaim Docker space in one or two clicks. Each row says what it would remove
 * and about how much, from the list already on screen (no extra query); "Review & clean" opens a sheet that shows
 * exactly what goes. "Recommended clean-up" opens the same sheet with three categories ticked. Volumes are never
 * offered here.
 */
export function QuickCleanup({ spark, data, peers, access, asAdmin, onChanged }: QuickCleanupProps) {
  const { t } = useTranslation("storage");
  const [days, setDays] = useQuickDays();
  const [sheet, setSheet] = useState<readonly QuickPresetId[] | null>(null);
  const [outcome, setOutcome] = useState<QuickOutcome | null>(null);
  const resultRef = useRef<HTMLDivElement | null>(null);
  const titleId = useId();
  const daysLabelId = useId();
  const recNoteId = useId();
  // One clock per list read, so the card and the sheet count the same items.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const now = useMemo(() => Date.now(), [data]);
  const rule = useMemo<QuickRule>(() => ({ days, now, includeBuiltHere: false }), [days, now]);
  const rows = useMemo(() => QUICK_PRESETS.map((id) => rowOf(id, data, rule, t)), [data, rule, t]);

  const rec = useMemo(() => planFor(data, RECOMMENDED_PRESETS, rule), [data, rule]);
  const recCache = !buildCacheEmpty(data);
  const recParts = [rec.images.length > 0 ? t("quickDetails.images", { count: rec.images.length }) : "", rec.containers.length > 0 ? t("quickDetails.containers", { count: rec.containers.length }) : "", recCache ? t("quickDetails.buildCache") : ""].filter(Boolean);
  const recOk = recParts.length > 0;
  const recWhat = joinCleanupItems(recParts, t);

  const summary = outcome ? outcomeSummary(outcome, t) : null;
  useEffect(() => {
    if (outcome) resultRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [outcome]);

  const openSheet = (presets: readonly QuickPresetId[], ok: boolean) => {
    if (!ok) return;
    setOutcome(null);
    setSheet(presets);
  };

  return (
    <section className="panel st-quick" aria-labelledby={titleId}>
      <header className="st-quick__head">
        <div>
          <h2 id={titleId}>
            <BoxIcon className="h-4 w-4" /> {t("quickCleanup.title", { })}
          </h2>
          <p>{t("quickCleanup.description", { })}</p>
        </div>
        <div className="st-quick__age">
          <span id={daysLabelId} className="st-quick__agelabel">
            {t("quickCleanup.olderThan", { })}
          </span>
          <DaysControl days={days} onChange={setDays} labelledBy={daysLabelId} />
        </div>
      </header>

      {summary ? (
        <div ref={resultRef}>
          <Banner tone={summary.tone} onDismiss={() => setOutcome(null)}>
            <p className="st-quick__result">{summary.text}</p>
            {summary.problems.length > 0 ? (
              <details className="st-quick__problems">
                <summary>{t("quickCleanup.problems", { })}</summary>
                {summary.problems.map((p) => (
                  <div key={p.name}>
                    <b>{p.name}</b>
                    <ul>
                      {p.lines.map((line, i) => (
                        <li key={i}>{line}</li>
                      ))}
                    </ul>
                  </div>
                ))}
              </details>
            ) : null}
          </Banner>
        </div>
      ) : null}

      <div className="st-quick__rec">
        <button
          type="button"
          className="btn btn--primary st-quick__recbtn"
          aria-disabled={!recOk}
          aria-describedby={recNoteId}
          onClick={() => openSheet(RECOMMENDED_PRESETS, recOk)}
        >
          {t("quickCleanup.recommended", { })}
        </button>
        <p id={recNoteId} className="st-quick__recnote">
          {recOk ? (
            <>
              {t("quickDetails.recommendedNote", { days: t("quickCleanup.days", { count: days }), items: recWhat })}{" "}
              {rec.keptBuiltHere.length > 0 ? <>{t("quickCleanup.builtKept", { count: rec.keptBuiltHere.length })}{t("quickDetails.sentenceEnd")}{" "}</> : null}
              {t("quickDetails.untick")}
            </>
          ) : (
            <>{t("quickCleanup.nothingRecommended", { })}</>
          )}
        </p>
      </div>

      <ul className="st-quick__rows">
        {rows.map((r) => {
          const figureId = `${titleId}-${r.id}`;
          return (
            <li key={r.id} className={`st-quick__row${r.ok ? "" : " is-empty"}`}>
              <div className="st-quick__main">
                <span className="st-quick__title">{presetCopy(r.id, days, t).title}</span>
                <span className="st-quick__desc">{presetCopy(r.id, days, t).description}</span>
                {r.keptBuiltHere > 0 ? (
                  <span className="st-quick__kept">
                    {t("quickCleanup.builtKept", { count: r.keptBuiltHere })}
                  </span>
                ) : null}
              </div>
              <span className="st-quick__figure" id={figureId}>
                {r.figure}
              </span>
              <button type="button" className="btn btn--sm st-quick__go" aria-disabled={!r.ok} aria-describedby={figureId} onClick={() => openSheet([r.id], r.ok)}>
                {t("quickCleanup.reviewClean", { })}
              </button>
            </li>
          );
        })}
      </ul>

      <p className="st-hint st-quick__volumes">
        <b>{t("quickCleanup.volumesTitle", { })}</b>{" "}
        {t("quickCleanup.volumesText", { })}
      </p>

      <QuickCleanupSheet
        presets={sheet}
        spark={spark}
        data={data}
        days={days}
        now={now}
        peers={peers}
        asAdmin={asAdmin}
        access={access}
        onClose={() => setSheet(null)}
        onDone={(o) => {
          setSheet(null);
          setOutcome(o);
          onChanged();
        }}
      />
    </section>
  );
}
