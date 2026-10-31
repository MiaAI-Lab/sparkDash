import { useToolEvalCategories } from "./labels";
import { useTranslation } from "react-i18next";
import { useMemo, useState } from "react";
import type { ToolEvalRun } from "../../../api/types";
import { Tag } from "../../ui/Tag";
import { fmtDate, fmtNum } from "./format";
import { compareToolResults, deltaDigits } from "./compare";
import type { NormToolResult, ScenarioStatus } from "./normalize";
import { useToolEvalPresentation } from "./presentation";

const TONE: Record<ScenarioStatus, "good" | "warn" | "bad" | "neutral"> = { pass: "good", partial: "warn", fail: "bad", other: "neutral" };


function Delta({ a, b, higherIsBetter = true, suffix = "", digits }: { a: number | null; b: number | null; higherIsBetter?: boolean; suffix?: string; digits: number }) {
  if (a == null || b == null) return <span className="te-faint">–</span>;
  const d = b - a;
  if (Math.abs(d) < 10 ** -digits / 2) return <span className="te-delta">±0</span>;
  const good = higherIsBetter ? d > 0 : d < 0;
  return (
    <span className={`te-delta ${good ? "is-good" : "is-bad"}`}>
      {d > 0 ? "+" : ""}
      {fmtNum(d, digits)}
      {suffix}
    </span>
  );
}

const count = (n: NormToolResult, v: number) => (n.scenarios.length ? v : "–");

function RunHead({ side, run, n, other, sparkName }: { side: "A" | "B"; run: ToolEvalRun; n: NormToolResult; other: NormToolResult; sparkName?: string | null }) {
  const { t } = useTranslation("tooleval");
  const presentation = useToolEvalPresentation();
  return (
    <div className={`te-sbs__head te-sbs__head--${side.toLowerCase()}`}>
      <span className="eyebrow">{t("ui.text.run")} {side}{sparkName ? ` · ${sparkName}` : ""}</span>
      <b className="te-sbs__title">{run.label || fmtDate(run.startedAt)}</b>
      <span className="te-faint">{run.label ? `${fmtDate(run.startedAt)} · ` : ""}{run.model ?? n.model ?? t("ui.autoModel")}</span>
      <div className="te-sbs__score">
        <span className="te-sbs__num">{n.score != null ? fmtNum(n.score, 1) : "–"}</span>
        {side === "B" ? <Delta a={other.score} b={n.score} digits={deltaDigits(other.score, n.score)} /> : null}
      </div>
      <div className="te-sbs__counts mono">
        <span className="is-pass">{count(n, n.counts.pass)} {t("ui.pass")}</span>
        <span className="is-partial">{count(n, n.counts.partial)} {t("ui.partial")}</span>
        <span className="is-fail">{count(n, n.counts.fail)} {t("ui.fail")}</span>
      </div>
    </div>
  );
}

/** Two tool-call results next to each other: scores, category bars and a scenario-by-scenario table. */
export function SideBySide({
  a,
  b,
  runA,
  runB,
  sparkNameA,
  sparkNameB,
  onSwap,
}: {
  a: NormToolResult;
  b: NormToolResult;
  runA: ToolEvalRun;
  runB: ToolEvalRun;
  /** Set when the runs came from different Sparks. */
  sparkNameA?: string | null;
  sparkNameB?: string | null;
  onSwap: () => void;
}) {
  const { t } = useTranslation("tooleval");
  const presentation = useToolEvalPresentation();
  const categoryNames = useToolEvalCategories();
  const labels: Record<ScenarioStatus, string> = { pass: t("ui.pass"), partial: t("ui.partial"), fail: t("ui.fail"), other: t("ui.other") };
  const [onlyDiff, setOnlyDiff] = useState(true);
  // One comparison, shared with the tests: the same row kinds and deltas everywhere.
  const cmp = useMemo(() => compareToolResults(a, b, presentation), [a, b, presentation]);
  const cats = cmp.categories.map((c) => ({ id: c.id, name: categoryNames[c.id] ?? c.name ?? "", a: c.a, b: c.b, digits: c.digits }));
  const rows = cmp.rows;
  const hasRows = cmp.hasScenarios.a || cmp.hasScenarios.b;
  const shown = onlyDiff ? rows.filter((r) => r.kind !== "same") : rows;
  const nDiff = rows.length - cmp.unchanged;

  return (
    <div className="te-sbs">
      <div className="te-sbs__top">
        <RunHead side="A" run={runA} n={a} other={b} sparkName={sparkNameA} />
        <div className="te-sbs__mid">
          <button type="button" className="btn btn--sm btn--ghost" onClick={onSwap} title={t("ui.swapAAndB")}>
            {t("ui.swap")}
          </button>
        </div>
        <RunHead side="B" run={runB} n={b} other={a} sparkName={sparkNameB} />
      </div>

      <h3>{t("ui.metrics")}</h3>
      <div className="te-sbs__metrics">
        {cmp.headline
          .filter((m) => m.id !== "score" && m.id !== "partial")
          .map((m) => (
            <div key={m.id} className="te-sbs__row">
              <span className="te-sbs__val mono">{m.a != null ? fmtNum(m.a, m.digits) : "–"}</span>
              <span className="te-sbs__label">
                {m.label}
                <Delta a={m.a} b={m.b} higherIsBetter={m.higherIsBetter} digits={m.digits} />
              </span>
              <span className="te-sbs__val mono">{m.b != null ? fmtNum(m.b, m.digits) : "–"}</span>
            </div>
          ))}
      </div>

      {cats.length ? (
        <>
          <h3>{t("ui.quality.categories")}</h3>
          <div className="te-sbs__cats">
            {cats.map((c) => (
              <div key={c.id} className="te-sbs__cat">
                <div className="te-sbs__bar te-sbs__bar--a" title={c.a != null ? `${Math.round(c.a)}%` : t("ui.notInRunA")}>
                  <i style={{ width: `${Math.max(0, Math.min(100, c.a ?? 0))}%` }} />
                  <span className="mono">{c.a != null ? `${Math.round(c.a)}%` : "–"}</span>
                </div>
                <div className="te-sbs__catname">
                  <span className="te-catbars__id">{c.id}</span> {c.name}
                  <Delta a={c.a} b={c.b} suffix=" pts" digits={c.digits} />
                </div>
                <div className="te-sbs__bar te-sbs__bar--b" title={c.b != null ? `${Math.round(c.b)}%` : t("ui.notInRunB")}>
                  <i style={{ width: `${Math.max(0, Math.min(100, c.b ?? 0))}%` }} />
                  <span className="mono">{c.b != null ? `${Math.round(c.b)}%` : "–"}</span>
                </div>
              </div>
            ))}
          </div>
        </>
      ) : null}

      {hasRows ? (
        <>
      <div className="te-sbs__scn-head">
        <h3>
          {t("ui.scenarios_SideBySide")} <span className="te-faint">({nDiff} {t("ui.differOf")} {rows.length})</span>
        </h3>
        <label className="te-sbs__toggle">
          <input type="checkbox" checked={onlyDiff} onChange={(e) => setOnlyDiff(e.target.checked)} />
          {t("ui.onlyDifferences")}
        </label>
      </div>
      {shown.length ? (
        <div className="te-tablewrap">
          <table className="te-table te-sbs__table">
            <thead>
              <tr>
                <th scope="col">{t("ui.scenario")}</th>
                <th scope="col">{t("ui.quality.runA")}</th>
                <th scope="col">{t("ui.quality.runB")}</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.id} className={`is-${r.kind}`}>
                  <th scope="row">
                    <span className="mono">{r.id}</span> <span className="te-faint">{r.title ?? ""}</span>
                  </th>
                  <td>{r.from ? <Tag tone={TONE[r.from]}>{labels[r.from]}</Tag> : <span className="te-faint">{t("ui.notRun")}</span>}</td>
                  <td>{r.to ? <Tag tone={TONE[r.to]}>{labels[r.to]}</Tag> : <span className="te-faint">{t("ui.notRun")}</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="te-empty">{t("ui.everyScenarioEndedWithTheSameStatus")}</p>
      )}
        </>
      ) : null}
    </div>
  );
}
