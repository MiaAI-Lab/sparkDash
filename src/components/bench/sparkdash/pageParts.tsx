import type { ReactNode } from "react";
import "../../../styles/benchpages.css";
import type { HistoryRow } from "./historyRows";
import { useTranslation } from "react-i18next";

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
  const { t } = useTranslation("benchmarks");
  return (
    <div className={`bp-grid${stacked ? " bp-grid--stacked" : ""}`}>
      <section className="panel bp-config" aria-label={t("pageParts.runConfiguration")}>
        <div className="eyebrow">{t("pageParts.configuration")}</div>
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
  onDelete,
  busy,
}: {
  rows: readonly HistoryRow[];
  activeId: string | null;
  labelHeader: string;
  onView: (id: string) => void;
  /** Quality only: pick a run to compare the open one against. */
  onCompare?: (id: string) => void;
  compareId?: string;
  /** Quality only: remove one saved run. A run in flight offers no delete. */
  onDelete?: (id: string) => void;
  /** A run is in flight, so opening another would replace its live view. */
  busy: boolean;
}) {
  const { t } = useTranslation("benchmarks");
  return (
    <div className="bp-table-wrap">
      <table className="bp-table">
        <thead>
          <tr>
            <th>{t("history.date")}</th>
            <th>{labelHeader}</th>
            <th className="bp-model">{t("history.model")}</th>
            <th className="bp-num">{t("history.result")}</th>
            <th aria-label={t("history.actions")} />
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className={r.id === activeId ? "is-active" : undefined}>
              <td className="bp-nowrap">
                {formatWhen(r.startedAt)}
                {r.status !== "completed" ? (
                  <span className={`tag ${STATUS_TONE[r.status]} bp-status`}>{r.status}</span>
                ) : null}
              </td>
              <td className="bp-clip">{r.label}</td>
              <td className="bp-clip bp-model mono" title={r.model ?? undefined}>
                {r.model ?? "—"}
                {r.port != null ? <small> :{r.port}</small> : null}
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
                  {r.id === activeId ? t("history.open") : t("history.view")}
                </button>
                {onCompare && r.id !== activeId ? (
                  <button
                    type="button"
                    className="btn btn--sm btn--ghost"
                    disabled={busy || r.id === compareId}
                    onClick={() => onCompare(r.id)}
                  >
                  {r.id === compareId ? t("history.comparing") : t("history.compare")}
                  </button>
                ) : null}
                {onDelete && r.status !== "running" ? (
                  <button
                    type="button"
                    className="btn btn--sm btn--ghost"
                    onClick={() => onDelete(r.id)}
                    title={t("history.deleteTitle")}
                  >
                    {t("history.delete")}
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
