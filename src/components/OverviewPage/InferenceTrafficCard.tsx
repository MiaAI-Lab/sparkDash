import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { fetchInferenceActivity } from "../../api/client";
import type { InferenceActivity } from "../../api/types";
import { ActivityIcon } from "../ui/icons";
import { Panel } from "../ui/Panel";

const NO_RESPONSE_TIMEOUT_MS = 30_000;

function safeLabel(value: string, labels: string[], unknownLabel: string): string {
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(value) &&
    !/^(?:sk[-_]|bearer(?:[-_ ]|$)|eyJ)/i.test(value) && labels.includes(value) ? value : unknownLabel;
}

function age(value: number, lessThanOneSecond: string, seconds: (count: number) => string): string {
  return Number.isFinite(value) && value >= 0 ? value < 1000 ? lessThanOneSecond : seconds(Math.round(value / 1000)) : "—";
}

export function InferenceTrafficCard() {
  const { t } = useTranslation("overview");
  const [activity, setActivity] = useState<InferenceActivity | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    let loading = false;
    let disabled = false;
    let staleTimer: number | undefined;
    const load = async () => {
      if (loading || disabled) return;
      loading = true;
      try {
        const next = await fetchInferenceActivity();
        if (!alive) return;
        disabled = next.enabled === false;
        setActivity(next);
        setFailed(false);
        window.clearTimeout(staleTimer);
        // Expire a stalled transport, not the server's sample using the client's clock.
        if (next.available) staleTimer = window.setTimeout(() => {
          if (alive) setFailed(true);
        }, NO_RESPONSE_TIMEOUT_MS);
      } catch {
        if (alive) setFailed(true);
      } finally {
        loading = false;
      }
    };
    void load();
    const timer = window.setInterval(() => { void load(); }, 5000);
    return () => { alive = false; window.clearInterval(timer); window.clearTimeout(staleTimer); };
  }, []);

  if (activity?.enabled === false) return null;
  const available = activity?.available === true && !failed;
  const active = available ? activity.active : [];
  const recent = available ? activity.recent : [];
  const labels = activity?.labels ?? [];
  const unknownLabel = t("traffic.unknown");
  const formatAge = (value: number) => age(value, t("traffic.lessThanOneSecond"), (count) => t("traffic.seconds", { count }));
  const total = active.reduce((sum, item) => sum + item.count, 0);
  return (
    <Panel title={t("traffic.title")} icon={<ActivityIcon className="h-3.5 w-3.5" />} className="ov-card" bodyClassName="flex flex-col gap-3">
      <div className="flex items-baseline justify-between gap-2 text-[11px] text-muted">
        <span>{t("traffic.requestsByPrincipal")}</span>
        <span className={available ? "font-tabular text-success" : "text-muted"}>
          {available ? t("traffic.inFlight", { count: total }) : t("traffic.liveStatusUnavailable")}
        </span>
      </div>
      {!activity && !failed ? <p className="text-[12px] text-muted">{t("traffic.waiting")}</p> : !available ? (
        <p className="text-[12px] text-muted">{t("traffic.unavailable")}</p>
      ) : (
        <>
          <div className="flex flex-col gap-2">
            {active.length === 0 ? <p className="text-[12px] text-muted">{t("traffic.noInFlight")}</p> : active.map((item, index) => (
              <div key={`${item.principal}-${item.model}-${index}`} className="rounded border border-border bg-surface-elevated px-2.5 py-2">
                <div className="flex items-center justify-between gap-2 text-[12px]">
                  <span className="truncate font-semibold text-text-strong">{safeLabel(item.principal, labels, unknownLabel)}</span>
                  <span className="font-tabular text-success">{item.count}</span>
                </div>
                <div className="mt-1 text-[10px] text-muted">{item.model} · {t("traffic.oldest", { age: formatAge(item.oldestAgeMs) })}</div>
              </div>
            ))}
          </div>
          <div className="border-t border-border pt-2.5">
            <div className="mb-1.5 text-[10px] uppercase tracking-wide text-muted">{t("traffic.recentCompletions")}</div>
            {recent.slice(0, 6).map((event, index) => (
              <div key={`${event.observedAt}-${index}`} className="flex items-center justify-between gap-2 text-[11px]">
                <span className="truncate text-text">{safeLabel(event.principal, labels, unknownLabel)} · {event.model}</span>
                <span className={event.status != null && event.status >= 400 ? "text-danger" : "font-tabular text-muted"}>
                  {event.durationMs} ms{event.status != null ? ` · ${event.status}` : ""}
                </span>
              </div>
            ))}
            {recent.length === 0 ? <p className="text-[12px] text-muted">{t("traffic.noRecent")}</p> : null}
          </div>
        </>
      )}
      {available && activity?.overflowed ? <p className="text-[10px] text-warning">{t("traffic.capReached")}</p> : null}
      <p className="text-[10px] text-muted">{t("traffic.disclaimer")}</p>
    </Panel>
  );
}
