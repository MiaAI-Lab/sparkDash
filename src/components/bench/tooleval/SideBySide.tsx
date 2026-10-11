import { localizeBenchText } from "./benchText";
import { useTranslation } from "react-i18next";
import { i18next } from "../../../i18n";
import { useMemo, useState } from "react";
import type { ToolEvalRun } from "../../../api/types";
import { Tag } from "../../ui/Tag";
import { fmtDate, fmtNum } from "./format";
import { compareToolResults, deltaDigits } from "./compare";
import type { NormToolResult, ScenarioStatus } from "./normalize";

const TONE: Record<ScenarioStatus, "good" | "warn" | "bad" | "neutral"> = { pass: "good", partial: "warn", fail: "bad", other: "neutral" };
const LABEL: Record<ScenarioStatus, string> = { pass: "Pass", partial: "Partial", fail: "Fail", other: "Other" };

function Delta({ a, b, higherIsBetter = true, suffix = "", digits }: { a: number | null; b: number | null; higherIsBetter?: boolean; suffix?: string; digits: number }) {
  useTranslation();
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

function RunHead({ side, run, n, other }: { side: "A" | "B"; run: ToolEvalRun; n: NormToolResult; other: NormToolResult }) {
  useTranslation();
  return (
    <div className={`te-sbs__head te-sbs__head--${side.toLowerCase()}`}>
      <span className="eyebrow">{i18next.t("bench.ui.run_b1b392", "Run")} {side}</span>
      <b className="te-sbs__title">{run.label || fmtDate(run.startedAt)}</b>
      <span className="te-faint">{run.label ? `${fmtDate(run.startedAt)} · ` : ""}{run.model ?? n.model ?? i18next.t("bench.ui.autoModel_361286", "auto model")}</span>
      <div className="te-sbs__score">
        <span className="te-sbs__num">{n.score != null ? fmtNum(n.score, 1) : "–"}</span>
        {side === "B" ? <Delta a={other.score} b={n.score} digits={deltaDigits(other.score, n.score)} /> : null}
      </div>
      <div className="te-sbs__counts mono">
        <span className="is-pass">{count(n, n.counts.pass)} {i18next.t("bench.ui.pass_9d4e1e", "pass")}</span>
        <span className="is-partial">{count(n, n.counts.partial)} {i18next.t("bench.ui.partial_355705", "partial")}</span>
        <span className="is-fail">{count(n, n.counts.fail)} {i18next.t("bench.ui.fail_a602e2", "fail")}</span>
      </div>
    </div>
  );
}

/** Two tool-call results next to each other: scores, category bars and a scenario-by-scenario table. */
export function SideBySide({ a, b, runA, runB, onSwap }: { a: NormToolResult; b: NormToolResult; runA: ToolEvalRun; runB: ToolEvalRun; onSwap: () => void }) {
  const { i18n } = useTranslation();
  const [onlyDiff, setOnlyDiff] = useState(true);
  // One comparison, shared with the tests: the same row kinds and deltas everywhere.
  const cmp = useMemo(() => compareToolResults(a, b), [a, b, i18n.language]);
  const cats = cmp.categories.map((c) => ({ id: c.id, name: c.name ?? "", a: c.a, b: c.b, digits: c.digits }));
  const rows = cmp.rows;
  const hasRows = cmp.hasScenarios.a || cmp.hasScenarios.b;
  const shown = onlyDiff ? rows.filter((r) => r.kind !== "same") : rows;
  const nDiff = rows.length - cmp.unchanged;

  return (
    <div className="te-sbs">
      <div className="te-sbs__top">
        <RunHead side="A" run={runA} n={a} other={b} />
        <div className="te-sbs__mid">
          <button type="button" className="btn btn--sm btn--ghost" onClick={onSwap} title={i18next.t("bench.ui.swapAAndB_168313", "Swap A and B")}>{i18next.t("bench.ui.swap_b04158", "⇄ Swap")}</button>
        </div>
        <RunHead side="B" run={runB} n={b} other={a} />
      </div>

      <h3>{i18next.t("bench.ui.metrics_ddf6a1", "Metrics")}</h3>
      <div className="te-sbs__metrics">
        {cmp.headline
          .filter((m) => m.label !== "Score" && m.label !== "Partial")
          .map((m) => (
            <div key={m.label} className="te-sbs__row">
              <span className="te-sbs__val mono">{m.a != null ? fmtNum(m.a, m.digits) : "–"}</span>
              <span className="te-sbs__label">
                {localizeBenchText(m.label)}
                <Delta a={m.a} b={m.b} higherIsBetter={m.higherIsBetter} digits={m.digits} />
              </span>
              <span className="te-sbs__val mono">{m.b != null ? fmtNum(m.b, m.digits) : "–"}</span>
            </div>
          ))}
      </div>

      {cats.length ? (
        <>
          <h3>{i18next.t("bench.ui.categories_6ccb60", "Categories")}</h3>
          <div className="te-sbs__cats">
            {cats.map((c) => (
              <div key={c.id} className="te-sbs__cat">
                <div className="te-sbs__bar te-sbs__bar--a" title={c.a != null ? `${Math.round(c.a)}%` : i18next.t("bench.ui.notInRunA_edfdf1", "not in run A")}>
                  <i style={{ width: `${Math.max(0, Math.min(100, c.a ?? 0))}%` }} />
                  <span className="mono">{c.a != null ? `${Math.round(c.a)}%` : "–"}</span>
                </div>
                <div className="te-sbs__catname">
                  <span className="te-catbars__id">{c.id}</span> {localizeBenchText(c.name)}
                  <Delta a={c.a} b={c.b} suffix={" " + i18next.t("bench.ui.pts_87161b", "pts")} digits={c.digits} />
                </div>
                <div className="te-sbs__bar te-sbs__bar--b" title={c.b != null ? `${Math.round(c.b)}%` : i18next.t("bench.ui.notInRunB_77b3c2", "not in run B")}>
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
        <h3>{i18next.t("bench.ui.scenarios_2dd4a8", "Scenarios")} <span className="te-faint">({nDiff} {i18next.t("bench.ui.differOf_15f871", "differ of")} {rows.length})</span>
        </h3>
        <label className="te-sbs__toggle">
          <input type="checkbox" checked={onlyDiff} onChange={(e) => setOnlyDiff(e.target.checked)} />{i18next.t("bench.ui.onlyDifferences_78bb9f", "Only differences")}</label>
      </div>
      {shown.length ? (
        <div className="te-tablewrap">
          <table className="te-table te-sbs__table">
            <thead>
              <tr>
                <th scope="col">{i18next.t("bench.ui.scenario_569aae", "Scenario")}</th>
                <th scope="col">{i18next.t("bench.ui.runA_eb2b58", "Run A")}</th>
                <th scope="col">{i18next.t("bench.ui.runB_4e703c", "Run B")}</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.id} className={`is-${r.kind}`}>
                  <th scope="row">
                    <span className="mono">{r.id}</span> <span className="te-faint">{r.title ?? ""}</span>
                  </th>
                  <td>{r.from ? <Tag tone={TONE[r.from]}>{localizeBenchText(LABEL[r.from])}</Tag> : <span className="te-faint">{i18next.t("bench.ui.notRun_fd55e9", "not run")}</span>}</td>
                  <td>{r.to ? <Tag tone={TONE[r.to]}>{localizeBenchText(LABEL[r.to])}</Tag> : <span className="te-faint">{i18next.t("bench.ui.notRun_fd55e9", "not run")}</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="te-empty">{i18next.t("bench.ui.everyScenarioEndedWithTheSameStatus_a400d9", "Every scenario ended with the same status in both runs.")}</p>
      )}
        </>
      ) : null}
    </div>
  );
}
