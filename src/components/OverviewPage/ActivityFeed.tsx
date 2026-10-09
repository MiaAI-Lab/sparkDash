import { AppLink } from "../ui/AppLink";
import { ACTIVITY_ID, idToPath } from "../../constants";
import { useActivityEvents } from "../../hooks/useActivityEvents";
import { formatRelativeTime, severityDotClass, splitMessage } from "./activityFormat";

interface ActivityFeedProps {
  limit?: number;
  sparkId?: string;
  onSelectSpark?: (sparkId: string) => void;
  /** Opens the full Activity page. */
  onViewAll?: () => void;
}

/** Compact fleet timeline. Renders card contents only (no outer chrome). */
export function ActivityFeed({ limit = 8, sparkId, onSelectSpark, onViewAll }: ActivityFeedProps) {
  const { events, loading, error } = useActivityEvents({ sparkId });
  const now = Date.now();
  const shown = events.slice(0, limit);

  return (
    <section className="activity-feed" aria-label="Recent activity">
      <header className="mb-2 flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-text-strong">Recent activity</h3>
        <span className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-[10px] uppercase tracking-wide text-muted">
          <span className="h-1.5 w-1.5 rounded-full bg-success" aria-hidden="true" />
          live
        </span>
      </header>

      {loading && shown.length === 0 ? (
        <p className="py-2 text-xs text-muted">Loading…</p>
      ) : shown.length === 0 ? (
        <p className="py-2 text-xs text-muted">
          {error
            ? "Couldn't load activity."
            : "Nothing yet. Throttling, restarts, updates and benchmark runs will appear here."}
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {shown.map((ev) => {
            const { before, name, after } = splitMessage(ev.message, ev.sparkName);
            const clickable = Boolean(name && ev.sparkId && onSelectSpark);
            return (
              <li key={ev.id} className="flex items-baseline gap-2 py-1.5 text-xs">
                <time
                  className="w-10 shrink-0 text-right font-mono tabular-nums text-muted"
                  dateTime={new Date(ev.ts).toISOString()}
                  title={new Date(ev.ts).toLocaleString()}
                >
                  {formatRelativeTime(ev.ts, now)}
                </time>
                <span
                  className={`h-1.5 w-1.5 shrink-0 translate-y-[-1px] rounded-full ${severityDotClass(ev.severity)}`}
                  aria-label={ev.severity}
                />
                <span className="min-w-0 break-words text-muted-strong">
                  {before}
                  {name &&
                    (clickable ? (
                      <AppLink
                        href={idToPath(ev.sparkId as string)}
                        className="font-semibold text-text-strong hover:underline"
                        onNavigate={() => onSelectSpark!(ev.sparkId as string)}
                      >
                        {name}
                      </AppLink>
                    ) : (
                      <strong className="font-semibold text-text-strong">{name}</strong>
                    ))}
                  {after}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {onViewAll ? (
        <AppLink href={idToPath(ACTIVITY_ID)} className="btn btn--sm btn--ghost mt-2" onNavigate={onViewAll}>
          View all activity
        </AppLink>
      ) : null}
    </section>
  );
}

export default ActivityFeed;
