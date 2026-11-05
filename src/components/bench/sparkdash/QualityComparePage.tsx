import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { getQualityBench, listQualityBenchFleet } from "../../../api/client";
import type { QualityBenchJob, QualityReference } from "../../../api/types";
import { qualityFamilyKey } from "../../../shared/qualityBench.js";
import { BenchCopyButton } from "../../SparkPage/BenchCopyButton";
import { buildQualityShareCard } from "../../SparkPage/benchShareCard";
import { QualityRunComparison, qualityComparisonText } from "../../SparkPage/QualityBenchDialog";
import { useShareCardLabels } from "../tooleval/shareCardLabels";
import { PageCard, PageEmpty } from "./pageParts";

/** localStorage key remembering the last pair compared. */
const PICK_KEY = "sparkdash.quality.compare";

interface Pick {
  sparkId: string;
  benchId: string;
}

function readPicks(): { a: Pick | null; b: Pick | null } {
  try {
    const raw = localStorage.getItem(PICK_KEY);
    if (!raw) return { a: null, b: null };
    const v = JSON.parse(raw) as { a?: Pick | null; b?: Pick | null };
    return { a: v.a ?? null, b: v.b ?? null };
  } catch {
    return { a: null, b: null };
  }
}

function savePicks(a: Pick | null, b: Pick | null) {
  try {
    localStorage.setItem(PICK_KEY, JSON.stringify({ a, b }));
  } catch {
    /* per-viewer convenience only */
  }
}

const keyOf = (p: Pick | null) => (p ? `${p.sparkId}\u0000${p.benchId}` : "");
const parseKey = (k: string): Pick | null => {
  if (!k) return null;
  const [sparkId, benchId] = k.split("\u0000");
  return sparkId && benchId ? { sparkId, benchId } : null;
};

function runOptionLabel(job: QualityBenchJob): string {
  const when = new Date(job.startedAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  const parts = [job.unit?.name || job.sparkId, when];
  if (job.config.label) parts.push(job.config.label);
  parts.push(job.config.modelId || "unknown model");
  if (job.results?.overallPct != null) parts.push(`${job.results.overallPct.toFixed(1)}%`);
  parts.push(`suite v${job.config.suiteVersion}`);
  return parts.join(" · ");
}

/**
 * WP4: pick any two saved quality runs across the fleet and compare them: A is the run under
 * test, B the reference. Defaults B to the pinned reference of A's model family.
 */
export function QualityComparePage() {
  const { t } = useTranslation("benchmarks");
  const shareCardLabels = useShareCardLabels();
  const [runs, setRuns] = useState<QualityBenchJob[]>([]);
  const [references, setReferences] = useState<Record<string, QualityReference>>({});
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [picks, setPicks] = useState(() => readPicks());
  const [jobA, setJobA] = useState<QualityBenchJob | null>(null);
  const [jobB, setJobB] = useState<QualityBenchJob | null>(null);

  const refresh = useCallback(() => {
    void listQualityBenchFleet()
      .then((data) => {
        setRuns((data.runs ?? []).filter((r) => (r.results?.itemCount ?? 0) > 0 && r.status !== "running"));
        setReferences(data.references ?? {});
        setError(null);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoaded(true));
  }, []);
  useEffect(() => {
    refresh();
    const timer = setInterval(() => {
      if (!document.hidden) refresh();
    }, 15000);
    return () => clearInterval(timer);
  }, [refresh]);

  // Load the full runs for the picks (they may sit on different units).
  const loadPick = useCallback((p: Pick | null, set: (j: QualityBenchJob | null) => void) => {
    if (!p) {
      set(null);
      return () => {};
    }
    let cancelled = false;
    getQualityBench(p.sparkId, p.benchId)
      .then((j) => {
        if (!cancelled) set(j);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);
  useEffect(() => loadPick(picks.a, setJobA), [picks.a, loadPick]);
  useEffect(() => loadPick(picks.b, setJobB), [picks.b, loadPick]);

  // A chosen, B empty: the pinned reference of A's family, when it is another run.
  useEffect(() => {
    if (!picks.a || picks.b) return;
    const a = runs.find((r) => r.benchId === picks.a?.benchId);
    const ref = a ? references[qualityFamilyKey(a.config.modelId)] : undefined;
    if (ref && ref.benchId !== picks.a.benchId && runs.some((r) => r.benchId === ref.benchId)) {
      const next = { a: picks.a, b: { sparkId: ref.sparkId, benchId: ref.benchId } };
      setPicks(next);
      savePicks(next.a, next.b);
    }
  }, [picks, runs, references]);

  const byUnit = useMemo(() => {
    const groups = new Map<string, QualityBenchJob[]>();
    for (const r of runs) {
      const name = r.unit?.name || r.sparkId;
      groups.set(name, [...(groups.get(name) ?? []), r]);
    }
    return [...groups.entries()];
  }, [runs]);

  const choose = (side: "a" | "b", key: string) => {
    const next = { ...picks, [side]: parseKey(key) };
    setPicks(next);
    savePicks(next.a, next.b);
  };
  const swap = () => {
    const next = { a: picks.b, b: picks.a };
    setPicks(next);
    savePicks(next.a, next.b);
  };

  const picker = (side: "a" | "b") => (
    <label className="q-pick q-pick--wide">
      <span>{side === "a" ? t("compare.pickA") : t("compare.pickB")}</span>
      <select value={keyOf(picks[side])} onChange={(e) => choose(side, e.target.value)} aria-label={side === "a" ? t("compare.pickA") : t("compare.pickB")}>
        <option value="">{t("quality.pickRun")}</option>
        {byUnit.map(([unit, list]) => (
          <optgroup key={unit} label={unit}>
            {list.map((r) => (
              <option key={r.benchId} value={keyOf({ sparkId: r.sparkId, benchId: r.benchId })}>
                {runOptionLabel(r)}
                {references[qualityFamilyKey(r.config.modelId)]?.benchId === r.benchId ? ` · ${t("quality.referenceTag")}` : ""}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
    </label>
  );

  const ready = jobA && jobB && jobA.benchId === picks.a?.benchId && jobB.benchId === picks.b?.benchId;
  return (
    <div className="bench-page__stack">
      <PageCard
        title={t("compare.title")}
        tools={
          <>
            {ready ? (
              <BenchCopyButton
                text={qualityComparisonText(jobA, jobB)}
                buildCard={() =>
                  buildQualityShareCard(jobA, jobB, {
                    llmPort: jobA.config.port,
                    modelId: jobA.config.modelId,
                    sparkName: jobA.unit?.name ?? null,
                    engine: jobA.engine?.record?.backend ?? null,
                    remoteHost: jobA.config.host ?? null,
                    labels: shareCardLabels,
                  })
                }
                kind="quality"
                shareImage={false}
                onError={setError}
              />
            ) : null}
            <button type="button" className="btn btn--sm btn--ghost" onClick={swap} disabled={!picks.a && !picks.b} title={t("compare.swapTitle")}>
              {t("compare.swap")}
            </button>
          </>
        }
      >
        <p className="bench-sheet__hint">{t("compare.hint")}</p>
        <div className="q-compare__pickers">
          {picker("a")}
          {picker("b")}
        </div>
        {error && <p className="bench-sheet__error">{error}</p>}
        {loaded && runs.length === 0 && <p className="bench-sheet__hint">{t("compare.noRuns")}</p>}
      </PageCard>
      {ready ? (
        <PageCard title={t("compare.resultTitle")}>
          <QualityRunComparison job={jobA} compareJob={jobB} />
        </PageCard>
      ) : picks.a && picks.b ? (
        <p className="bench-sheet__hint">{t("compare.loading")}</p>
      ) : (
        <PageEmpty title={t("compare.emptyTitle")}>{t("compare.emptyBody")}</PageEmpty>
      )}
    </div>
  );
}
