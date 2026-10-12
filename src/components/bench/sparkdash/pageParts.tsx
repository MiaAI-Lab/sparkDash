import { t } from "../../../i18n";
import type { ReactNode } from "react";
import "../../../styles/benchpages.css";
import type { HistoryRow } from "./historyRows";

/** Two-column page body: run configuration on the left, progress / results / history on the right. */
export function PageLayout({
  config,
  runBar,
  stacked = false,
  children,
}: {
  config: ReactNode;
  runBar?: ReactNode;
  /** Configuration on top, full width, with the results below (instead of a side column). */
  stacked?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={`bp-grid${stacked ? " bp-grid--stacked" : ""}`}>
      <section className="panel bp-config" aria-label={t("bench.run_configuration_fbcd_2")}>
        <div className="eyebrow">{t("bench.configuration")}</div>
        {config}
        {runBar ? <div className="bp-runbar">{runBar}</div> : null}
      </section>
      <div className="bp-main">{children}</div>
    </div>
  );
}

/** A titled card on the right-hand column. */
export function PageCard({
  title,
  tools,
  children,
}: {
  title: string;
  tools?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="panel bp-card">
      <div className="bp-card__head">
        <span className="eyebrow">{title}</span>
        {tools ? <div className="bp-card__tools">{tools}</div> : null}
      </div>
      {children}
    </section>
  );
}

export function PageEmpty({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="panel bp-empty">
      <strong>{title}</strong>
      <p>{children}</p>
    </section>
  );
}

const STATUS_TONE: Record<HistoryRow["status"], string> = {
  running: "tag--info",
  completed: "tag--good",
  failed: "tag--bad",
  cancelled: "tag--warn",
};

function formatWhen(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Saved runs for this Spark + port, newest first. `View` reopens a run in the results card. */
export function HistoryTable({
  rows,
  activeId,
  labelHeader,
  onView,
  onCompare,
  compareId,
  busy,
}: {
  rows: readonly HistoryRow[];
  activeId: string | null;
  labelHeader: string;
  onView: (id: string) => void;
  /** Quality only: pick a run to compare the open one against. */
  onCompare?: (id: string) => void;
  compareId?: string;
  /** A run is in flight, so opening another would replace its live view. */
  busy: boolean;
}) {
  return (
    <div className="bp-table-wrap">
      <table className="bp-table">
        <thead>
          <tr>
            <th>{t("bench.col_date")}</th>
            <th>{labelHeader}</th>
            <th className="bp-model">{t("tokens.col_model")}</th>
            <th className="bp-num">{t("bench.col_result")}</th>
            <th aria-label="Actions" />
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className={r.id === activeId ? "is-active" : undefined}>
              <td className="bp-nowrap">
                {formatWhen(r.startedAt)}
                {r.status !== "completed" ? (
                  <span className={`tag ${STATUS_TONE[r.status]} bp-status`}>{t(`bench.st_${r.status}`)}</span>
                ) : null}
              </td>
              <td className="bp-clip">{r.label}</td>
              <td className="bp-clip bp-model mono" title={r.model ?? undefined}>
                {r.model ?? "—"}
              </td>
              <td className="bp-num">
                <strong>{r.headline}</strong>
                {r.detail ? <small>{r.detail}</small> : null}
              </td>
              <td className="bp-row-actions">
                <button
                  type="button"
                  className="btn btn--sm"
                  disabled={busy || r.id === activeId}
                  onClick={() => onView(r.id)}
                >
                  {r.id === activeId ? t("bench.open") : t("bench.view")}
                </button>
                {onCompare && r.id !== activeId ? (
                  <button
                    type="button"
                    className="btn btn--sm btn--ghost"
                    disabled={busy || r.id === compareId}
                    onClick={() => onCompare(r.id)}
                  >
                    {r.id === compareId ? t("bench.comparing") : t("bench.compare")}
                  </button>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
