import type { HealthFinding } from "../../api/types";
import type { TFunction } from "i18next";
import { Tag } from "./Tag";
import { AlertTriangleIcon } from "./icons";
import { useTranslation } from "react-i18next";
import { useServerMessage } from "../../i18n/serverMessages";

const RANK = { critical: 0, warn: 1 } as const;
const THERMAL_WARNING = "GPU is running hot";
const THERMAL_CRITICAL = "GPU is close to its shutdown temperature";
const THERMAL_HINT = "Check airflow and the room temperature, and that nothing blocks the vents. Lower the power limit or the load if it keeps climbing.";
const THERMAL_DETAIL = /^(-?\d+)°C \(warns at (\d+(?:\.\d+)?)°C, critical at (\d+(?:\.\d+)?)°C\)\.$/;

/** Localize the HealthEvaluator thermal template while retaining custom diagnostics. */
function legacyFindingText(finding: HealthFinding, t: TFunction<"overview">) {
  const { id, severity, title, detail, hint } = finding;
  const critical = severity === "critical";
  if (id !== "thermal" || title !== (critical ? THERMAL_CRITICAL : THERMAL_WARNING)) {
    return { title, detail, hint };
  }
  const temperatures = detail.length <= 128 ? THERMAL_DETAIL.exec(detail) : null;
  return {
    title: critical ? t("health.thermal.criticalTitle") : t("health.thermal.warningTitle"),
    detail: temperatures
      ? t("health.thermal.detail", { current: temperatures[1], warning: temperatures[2], critical: temperatures[3] })
      : detail,
    hint: hint === THERMAL_HINT ? t("health.thermal.hint") : hint,
  };
}

function findingText(finding: HealthFinding, t: TFunction<"overview">, render: ReturnType<typeof useServerMessage>) {
  const { title, detail, hint } = legacyFindingText(finding, t);
  return {
    title: render(finding.i18n?.title, title),
    detail: render(finding.i18n?.detail, detail),
    hint: render(finding.i18n?.hint, hint),
  };
}

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
  const { t } = useTranslation("overview");
  const render = useServerMessage(t);
  const list = sortFindings(findings);
  if (list.length === 0) return null;
  const shown = list.slice(0, 2);
  const more = list.length - shown.length;
  return (
    <div className="health-strip" role="status" aria-label={t("health.findings")}>
      {shown.map((f) => {
        const { title, detail, hint } = findingText(f, t, render);
        return (
          <div key={f.id} className={`health-row health-row--${f.severity}`} title={`${detail} ${hint}`}>
            <AlertTriangleIcon className="health-row__icon" />
            <span className="health-row__text">{title}</span>
          </div>
        );
      })}
      {more > 0 ? (
        <div className="health-more" title={list.slice(2).map((f) => findingText(f, t, render).title).join("\n")}>
          {t("health.more", { count: more })}
        </div>
      ) : null}
    </div>
  );
}

/** Full list for the Spark page: what is wrong, the evidence, and what to try. */
export function HealthList({ findings }: { findings: readonly HealthFinding[] | undefined }) {
  const { t } = useTranslation("overview");
  const render = useServerMessage(t);
  const list = sortFindings(findings);
  if (list.length === 0) return null;
  return (
    <section className="health-list" aria-label={t("health.findings")}>
      {list.map((f) => {
        const { title, detail, hint } = findingText(f, t, render);
        const critical = f.severity === "critical";
        return (
          <div key={f.id} className={`health-item health-item--${f.severity}`}>
            <div className="health-item__title">
              <Tag tone={critical ? "bad" : "warn"}>{critical ? t("health.critical") : t("health.warning")}</Tag>
              <strong>{title}</strong>
            </div>
            <div className="health-item__detail">{detail}</div>
            <div className="health-item__hint">{hint}</div>
          </div>
        );
      })}
    </section>
  );
}
