import type { HealthFinding } from "../../api/types";
import { Tag } from "./Tag";

const RANK = { critical: 0, warn: 1 } as const;

/** Critical first, then by id so the order is stable between polls. */
export function sortFindings(list: readonly HealthFinding[] | undefined): HealthFinding[] {
  return [...(list ?? [])].sort(
    (a, b) => RANK[a.severity] - RANK[b.severity] || a.id.localeCompare(b.id)
  );
}

/** Compact chips for an Overview card: the title, the details in the tooltip. */
export function HealthChips({ findings }: { findings: readonly HealthFinding[] | undefined }) {
  const list = sortFindings(findings);
  if (list.length === 0) return null;
  const shown = list.slice(0, 2);
  const more = list.length - shown.length;
  return (
    <div className="health-chips" role="status" aria-label="Health findings">
      {shown.map((f) => (
        <Tag key={f.id} tone={f.severity === "critical" ? "bad" : "warn"} title={`${f.detail} ${f.hint}`}>
          {f.title}
        </Tag>
      ))}
      {more > 0 ? <Tag tone="neutral" title={list.slice(2).map((f) => f.title).join("\n")}>+{more} more</Tag> : null}
    </div>
  );
}

/** Full list for the Spark page: what is wrong, the evidence, and what to try. */
export function HealthList({ findings }: { findings: readonly HealthFinding[] | undefined }) {
  const list = sortFindings(findings);
  if (list.length === 0) return null;
  return (
    <section className="health-list" aria-label="Health findings">
      {list.map((f) => (
        <div key={f.id} className={`health-item health-item--${f.severity}`}>
          <div className="health-item__title">
            <Tag tone={f.severity === "critical" ? "bad" : "warn"}>{f.severity === "critical" ? "Critical" : "Warning"}</Tag>
            <strong>{f.title}</strong>
          </div>
          <div className="health-item__detail">{f.detail}</div>
          <div className="health-item__hint">{f.hint}</div>
        </div>
      ))}
    </section>
  );
}
