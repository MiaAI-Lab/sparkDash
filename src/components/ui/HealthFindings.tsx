import type { HealthFinding } from "../../api/types";
import { Tag } from "./Tag";
import { AlertTriangleIcon } from "./icons";
import { useServerMessage } from "../../i18n/serverMessages";
import { useTranslation } from "react-i18next";

const RANK = { critical: 0, warn: 1 } as const;

/** Critical first, then by id so the order is stable between polls. */
export function sortFindings(list: readonly HealthFinding[] | undefined): HealthFinding[] {
  return [...(list ?? [])].sort(
    (a, b) => RANK[a.severity] - RANK[b.severity] || a.id.localeCompare(b.id)
  );
}

/** "critical" | "warn" | null: the worst active finding, for tinting a card. */
export function worstSeverity(list: readonly HealthFinding[] | undefined): HealthFinding["severity"] | null {
  if (!list || list.length === 0) return null;
  return list.some((f) => f.severity === "critical") ? "critical" : "warn";
}

/** Alert strip for an Overview card: icon + title per finding, details in the tooltip. */
export function HealthChips({ findings }: { findings: readonly HealthFinding[] | undefined }) {
  const { t } = useTranslation("serverMessages");
  const render = useServerMessage();
  const list = sortFindings(findings);
  if (list.length === 0) return null;
  const shown = list.slice(0, 2);
  const more = list.length - shown.length;
  return (
    <div className="health-strip" role="status" aria-label={t("ui.healthFindings")}>
      {shown.map((f) => (
        <div key={f.id} className={`health-row health-row--${f.severity}`} title={`${render(f.i18n?.detail, f.detail)} ${render(f.i18n?.hint, f.hint)}`}>
          <AlertTriangleIcon className="health-row__icon" />
          <span className="health-row__text">{render(f.i18n?.title, f.title)}</span>
        </div>
      ))}
      {more > 0 ? (
        <div className="health-more" title={list.slice(2).map((f) => render(f.i18n?.title, f.title)).join("\n")}>
          {t("ui.more", { count: more })}
        </div>
      ) : null}
    </div>
  );
}

/** Full list for the Spark page: what is wrong, the evidence, and what to try. */
export function HealthList({ findings }: { findings: readonly HealthFinding[] | undefined }) {
  const { t } = useTranslation("serverMessages");
  const render = useServerMessage();
  const list = sortFindings(findings);
  if (list.length === 0) return null;
  return (
    <section className="health-list" aria-label={t("ui.healthFindings")}>
      {list.map((f) => (
        <div key={f.id} className={`health-item health-item--${f.severity}`}>
          <div className="health-item__title">
            <Tag tone={f.severity === "critical" ? "bad" : "warn"}>{f.severity === "critical" ? t("ui.critical") : t("ui.warning")}</Tag>
            <strong>{render(f.i18n?.title, f.title)}</strong>
          </div>
          <div className="health-item__detail">{render(f.i18n?.detail, f.detail)}</div>
          <div className="health-item__hint">{render(f.i18n?.hint, f.hint)}</div>
        </div>
      ))}
    </section>
  );
}
