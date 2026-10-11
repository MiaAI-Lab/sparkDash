import { memo, useState, type KeyboardEvent, type MouseEvent } from "react";
import { useTranslation } from "react-i18next";
import type { ActivityEvent } from "../../api/types";
import { i18next } from "../../i18n";
import { localizedActivityMessage } from "../../i18n/messages";
import { ChevronRightIcon } from "../ui/icons";
import { Tag, type TagTone } from "../ui/Tag";
import { splitMessage } from "../OverviewPage/activityFormat";
import { categorize, categoryLabel, formatClock, formatStamp, severityLabel, typeLabel } from "./activityStats";

const SEV_TONE: Record<ActivityEvent["severity"], TagTone> = { error: "bad", warn: "warn", success: "good", info: "info" };

function formatAgo(ts: number, now: number): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return i18next.t("activity.updated.justNow", "just now");
  const m = Math.floor(s / 60);
  if (m < 60) return i18next.t("activity.updated.minutesAgo", "{count} min ago", { count: m });
  const h = Math.floor(m / 60);
  if (h < 48) return i18next.t("activity.ago.hours", "{count} h ago", { count: h });
  return i18next.t("activity.ago.days", "{count} d ago", { count: Math.floor(h / 24) });
}

interface EventRowProps {
  event: ActivityEvent;
  open: boolean;
  fresh: boolean;
  now: number;
  onToggle: (id: number) => void;
  onSelectSpark?: (id: string) => void;
}

/** One timeline row: summary line plus an expandable detail block. */
export const EventRow = memo(function EventRow({ event: e, open, fresh, now, onToggle, onSelectSpark }: EventRowProps) {
  const { t } = useTranslation();
  const localizedMessage = localizedActivityMessage(e);
  const { before, name, after } = splitMessage(localizedMessage, e.sparkName);
  const clickable = Boolean(e.sparkId && onSelectSpark);
  const label = typeLabel(e.type);
  const detailId = `ac-ev-${e.id}`;
  const hasData = e.data !== undefined && e.data !== null;
  const [copied, setCopied] = useState(false);

  // Clicking the row toggles it, unless the user is selecting text or hit an inner control.
  const onRowClick = (ev: MouseEvent<HTMLDivElement>) => {
    if ((ev.target as HTMLElement).closest("button, a, pre")) return;
    if (window.getSelection()?.toString()) return;
    onToggle(e.id);
  };
  const onToggleKey = (ev: KeyboardEvent<HTMLButtonElement>) => {
    if (ev.key === "Escape" && open) onToggle(e.id);
  };

  const copyData = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(e.data, null, 2));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  return (
    <li className={`ac-row ac-row--${e.severity}${open ? " is-open" : ""}${fresh ? " is-fresh" : ""}`}>
      <div className="ac-row__main" onClick={onRowClick}>
        <time className="ac-row__time mono" dateTime={new Date(e.ts).toISOString()} title={formatStamp(e.ts)}>
          {formatClock(e.ts)}
        </time>
        <span className="ac-sev">
          <i className={`ac-sev__dot ac-sev__dot--${e.severity}`} aria-hidden="true" />
          {severityLabel(e.severity)}
        </span>
        <p className="ac-row__msg">
          {before}
          {name &&
            (clickable ? (
              <button
                type="button"
                className="ac-spark"
                onClick={() => onSelectSpark!(e.sparkId as string)}
                title={t("activity.row.openSpark", "Open {name}", { name })}
              >
                {name}
              </button>
            ) : (
              <strong>{name}</strong>
            ))}
          {after}
        </p>
        <Tag tone={e.severity === "info" ? "neutral" : SEV_TONE[e.severity]} className="ac-row__tag" title={e.type}>
          {label}
        </Tag>
        <button
          type="button"
          className="ac-row__toggle"
          aria-expanded={open}
          aria-controls={detailId}
          aria-label={
            open
              ? t("activity.row.hideDetails", "Hide details: {label}", { label })
              : t("activity.row.showDetails", "Show details: {label}", { label })
          }
          onClick={() => onToggle(e.id)}
          onKeyDown={onToggleKey}
        >
          <ChevronRightIcon className="h-4 w-4" />
        </button>
      </div>
      {open ? (
        <dl className="ac-detail" id={detailId}>
          <div className="ac-detail__wide">
            <dt>{t("activity.detail.message", "Message")}</dt>
            <dd>{localizedMessage}</dd>
          </div>
          <div>
            <dt>{t("activity.detail.time", "Time")}</dt>
            <dd className="mono">
              {formatStamp(e.ts)} <span className="ac-detail__dim">({formatAgo(e.ts, now)})</span>
            </dd>
          </div>
          <div>
            <dt>{t("activity.detail.severity", "Severity")}</dt>
            <dd>{severityLabel(e.severity)}</dd>
          </div>
          <div>
            <dt>{t("activity.detail.type", "Type")}</dt>
            <dd className="mono">{e.type}</dd>
          </div>
          <div>
            <dt>{t("activity.detail.eventId", "Event id")}</dt>
            <dd className="mono">#{e.id}</dd>
          </div>
          {e.sparkId ? (
            <div>
              <dt>{t("activity.detail.spark", "Spark")}</dt>
              <dd>
                {e.sparkName ?? e.sparkId} <span className="ac-detail__dim mono">{e.sparkId}</span>
              </dd>
            </div>
          ) : null}
          <div>
            <dt>{t("activity.detail.category", "Category")}</dt>
            <dd>{categoryLabel(categorize(e.type))}</dd>
          </div>
          {hasData ? (
            <div className="ac-detail__wide">
              <dt>
                {t("activity.detail.data", "Data")}
                <button type="button" className="ac-detail__copy" onClick={() => void copyData()}>
                  {copied ? t("activity.detail.copied", "Copied") : t("activity.detail.copy", "Copy")}
                </button>
              </dt>
              <dd>
                <pre className="ac-detail__data">{typeof e.data === "string" ? e.data : JSON.stringify(e.data, null, 2)}</pre>
              </dd>
            </div>
          ) : null}
        </dl>
      ) : null}
    </li>
  );
});
