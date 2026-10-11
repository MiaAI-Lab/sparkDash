import { useEffect, useState } from "react";
import { fetchInferenceActivity } from "../../api/client";
import type { InferenceActivity } from "../../api/types";
import { ActivityIcon } from "../ui/icons";
import { Panel } from "../ui/Panel";

function safeLabel(value: string, labels: string[]): string {
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(value) &&
    !/^(?:sk[-_]|bearer(?:[-_ ]|$)|eyJ)/i.test(value) && labels.includes(value) ? value : "unknown";
}

function age(value: number): string {
  return Number.isFinite(value) && value >= 0 ? value < 1000 ? "<1s" : `${Math.round(value / 1000)}s` : "—";
}

export function InferenceTrafficCard() {
  const [activity, setActivity] = useState<InferenceActivity | null>(null);
  const [failed, setFailed] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    let alive = true;
    let loading = false;
    let disabled = false;
    const load = async () => {
      if (loading || disabled) return;
      loading = true;
      try {
        const next = await fetchInferenceActivity();
        if (!alive) return;
        disabled = next.enabled === false;
        setActivity(next);
        setNow(Date.now());
        setFailed(false);
      } catch {
        if (alive) setFailed(true);
      } finally {
        loading = false;
      }
    };
    void load();
    const timer = window.setInterval(() => { setNow(Date.now()); void load(); }, 5000);
    return () => { alive = false; window.clearInterval(timer); };
  }, []);

  if (activity?.enabled === false) return null;
  const generatedMs = Date.parse(activity?.generatedAt ?? "");
  const available = activity?.available === true && !failed && Number.isFinite(generatedMs) &&
    now - generatedMs <= 30_000 && generatedMs <= now + 10_000;
  const active = available ? activity.active : [];
  const recent = available ? activity.recent : [];
  const labels = activity?.labels ?? [];
  const total = active.reduce((sum, item) => sum + item.count, 0);
  return (
    <Panel title="Inference activity" icon={<ActivityIcon className="h-3.5 w-3.5" />} className="ov-card" bodyClassName="flex flex-col gap-3">
      <div className="flex items-baseline justify-between gap-2 text-[11px] text-muted">
        <span>Requests by principal</span>
        <span className={available ? "font-tabular text-success" : "text-muted"}>
          {available ? `${total} in flight` : "Live status unavailable"}
        </span>
      </div>
      {!activity && !failed ? <p className="text-[12px] text-muted">Waiting for inference activity…</p> : !available ? (
        <p className="text-[12px] text-muted">Inference activity unavailable; request counts are unknown.</p>
      ) : (
        <>
          <div className="flex flex-col gap-2">
            {active.length === 0 ? <p className="text-[12px] text-muted">No in-flight inference requests now.</p> : active.map((item, index) => (
              <div key={`${item.principal}-${item.model}-${index}`} className="rounded border border-border bg-surface-elevated px-2.5 py-2">
                <div className="flex items-center justify-between gap-2 text-[12px]">
                  <span className="truncate font-semibold text-text-strong">{safeLabel(item.principal, labels)}</span>
                  <span className="font-tabular text-success">{item.count}</span>
                </div>
                <div className="mt-1 text-[10px] text-muted">{item.model} · oldest {age(item.oldestAgeMs)}</div>
              </div>
            ))}
          </div>
          <div className="border-t border-border pt-2.5">
            <div className="mb-1.5 text-[10px] uppercase tracking-wide text-muted">Recent completions</div>
            {recent.slice(0, 6).map((event, index) => (
              <div key={`${event.observedAt}-${index}`} className="flex items-center justify-between gap-2 text-[11px]">
                <span className="truncate text-text">{safeLabel(event.principal, labels)} · {event.model}</span>
                <span className={event.status != null && event.status >= 400 ? "text-danger" : "font-tabular text-muted"}>
                  {event.durationMs} ms{event.status != null ? ` · ${event.status}` : ""}
                </span>
              </div>
            ))}
            {recent.length === 0 ? <p className="text-[12px] text-muted">No recent completed requests.</p> : null}
          </div>
        </>
      )}
      {available && activity?.overflowed ? <p className="text-[10px] text-warning">Activity cap reached; counts may be incomplete.</p> : null}
      <p className="text-[10px] text-muted">In flight includes queueing, prefill and decode; not GPU slots or per-key tok/s. Display labels only; no API keys or prompts.</p>
    </Panel>
  );
}
