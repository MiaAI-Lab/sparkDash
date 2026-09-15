import { useCallback, useEffect, useState } from "react";
import { fetchAutoPower, updateAutoPowerConfig } from "../../api/client";
import type { AutoPowerStatus } from "../../api/types";
import { Panel } from "../ui/Panel";
import { GearIcon } from "../ui/icons";

/**
 * Full-width Overview card: Spark AutoPower.
 *
 * Watches the AI proxy (in-flight requests) and the dev engine (slots,
 * tickets, plan runs). After the configured idle span of verified quiet
 * inside the watch window, the remote Sparks are shut down; at the wake
 * time they are woken again (WoL). Workdays and weekends keep one span
 * each — the same rhythm as the model scheduler, minus the multi-window
 * complexity (one watch span + one wake time per day type).
 *
 * Data path: independent 10 s poll (same graceful-degrade pattern as
 * DevEnginePanel) — deliberately NOT in the WS snapshot, whose payload must
 * stay free of live counters.
 */

const POLL_MS = 10_000;

const DAY_LABEL = { weekday: "Workdays", weekend: "Weekend" } as const;
type DayType = "weekday" | "weekend";

/** "in 42 min" / "in 1 h 40 min" from an absolute epoch ms. */
function countdown(epochMs: number, nowMs: number): string {
  const mins = Math.max(0, Math.round((epochMs - nowMs) / 60_000));
  if (mins < 60) return `${mins} min`;
  return `${Math.floor(mins / 60)} h ${mins % 60} min`;
}

/** "yesterday 22:31" / "12:05" / "Sep 12 22:31" from an epoch ms (local). */
function whenLabel(epochMs: number, nowMs: number): string {
  const d = new Date(epochMs);
  const clock = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const dayDiff = Math.floor((nowMs - epochMs) / 86_400_000);
  if (dayDiff <= 0) return clock;
  if (dayDiff === 1) return `yesterday ${clock}`;
  return `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${clock}`;
}
/** True when text is non-empty but not a valid 24h clock. */
function badClock(v: string): boolean {
  return v.trim() !== "" && normalizeClock(v) === null;
}
/** Watch start/end additionally reject empty. */
function badRequiredClock(v: string): boolean {
  return v.trim() === "" || normalizeClock(v) === null;
}

/** Snap "8" / "8:00" to "08:00"; invalid values stay as typed until blur. */
function normalizeClock(value: string): string | null {
  const m = /^([01]?\d|2[0-3]):?([0-5]\d)?$/.exec(value.trim());
  if (!m) return null;
  return `${m[1].padStart(2, "0")}:${(m[2] ?? "0").padStart(2, "0")}`;
}

/** One HH:MM text input — 24h text, not type=time (see ModelScheduleDialog). */
function ClockInput({
  value,
  onChange,
  label,
  placeholder = "HH:MM",
  invalid = false,
}: {
  value: string;
  onChange: (v: string) => void;
  label: string;
  placeholder?: string;
  /** Red border when the current text is not a valid HH:MM. */
  invalid?: boolean;
}) {
  return (
    <input
      type="text"
      inputMode="numeric"
      maxLength={5}
      placeholder={placeholder}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onBlur={(e) => onChange(normalizeClock(e.target.value) ?? e.target.value)}
      title="24-hour clock with minute precision, e.g. 08:00 (not 8 AM). End ≤ start wraps past midnight."
      aria-label={label}
      className={`w-[4.5rem] rounded border bg-surface-elevated px-1.5 py-0.5 font-tabular text-xs text-text outline-none placeholder:text-muted/60 focus:border-accent ${
        invalid ? "border-danger" : "border-border"
      }`}
    />
  );
}

/** Source badge: green tick when reachable, red + reason when not, grey when never probed. */
function SourceBadge({
  name,
  ok,
  detail,
  error,
}: {
  name: string;
  ok: boolean | null;
  detail?: string;
  error?: string;
}) {
  const tone =
    ok === null
      ? "border-border text-muted"
      : ok
        ? "border-border text-muted"
        : "border-danger/40 text-danger";
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded border px-1.5 py-0.5 text-[11px] ${tone}`}
      title={ok === false ? error : ok === null ? "Not probed yet — AutoPower has not ticked while enabled" : undefined}
    >
      <span
        className={`h-1.5 w-1.5 rounded-full ${
          ok === null ? "bg-border" : ok ? "bg-success" : "bg-danger"
        }`}
      />
      {name}
      {ok === true && detail ? <span className="font-tabular text-text">{detail}</span> : null}
      {ok === false ? <span>unreachable</span> : null}
    </span>
  );
}

export function AutoPowerPanel() {
  const [status, setStatus] = useState<AutoPowerStatus | null | undefined>(undefined);
  const [now, setNow] = useState(() => Date.now());
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [triedSave, setTriedSave] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  // Draft settings (kept in sync whenever a fresh status arrives and the
  // dialog is not open — same "server owns the truth" rule as everywhere else).
  const [idleMin, setIdleMin] = useState("30");
  const [watch, setWatch] = useState<Record<DayType, { start: string; end: string }>>({
    weekday: { start: "22:00", end: "07:00" },
    weekend: { start: "23:00", end: "08:00" },
  });
  const [wake, setWake] = useState<Record<DayType, string>>({
    weekday: "08:00",
    weekend: "10:00",
  });

  const refresh = useCallback(async () => {
    try {
      const s = await fetchAutoPower();
      setStatus(s);
      if (!open) {
        const w = s.config.watch;
        setWatch({
          weekday: w.weekday[0] ? { start: w.weekday[0].start, end: w.weekday[0].end } : { start: "22:00", end: "07:00" },
          weekend: w.weekend[0] ? { start: w.weekend[0].start, end: w.weekend[0].end } : { start: "23:00", end: "08:00" },
        });
        setWake({
          weekday: s.config.wake.weekday ?? "",
          weekend: s.config.wake.weekend ?? "",
        });
      }
    } catch {
      setStatus(null); // server unreachable — graceful degrade
    }
  }, [open]);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(t);
  }, [refresh]);

  // Local countdown clock (payloads carry absolute epochs; this only renders).
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(t);
  }, []);

  const toggleEnabled = useCallback(async () => {
    if (!status) return;
    try {
      await updateAutoPowerConfig({ enabled: !status.config.enabled });
      void refresh();
    } catch (err) {
      setSaveErr(err instanceof Error ? err.message : "Toggle failed");
    }
  }, [status, refresh]);

  const save = useCallback(async () => {
    setSaving(true);
    setSaveErr(null);
    setTriedSave(true);
    try {
      await updateAutoPowerConfig({
        idleTimeoutMin: Number(idleMin),
        watch: {
          weekday: [watch.weekday],
          weekend: [watch.weekend],
        },
        wake: {
          weekday: wake.weekday.trim() || null,
          weekend: wake.weekend.trim() || null,
        },
      });
      setSavedAt(Date.now());
      void refresh();
    } catch (err) {
      setSaveErr(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }, [idleMin, watch, wake, refresh]);

  // ── Render ────────────────────────────────────────────────
  if (status === undefined) {
    return (
      <Panel title="Spark AutoPower" accent>
        <p className="text-xs text-muted">Waiting for the live feed…</p>
      </Panel>
    );
  }
  if (status === null) {
    return (
      <Panel title="Spark AutoPower" accent>
        <p className="text-xs text-muted">
          Server unreachable — AutoPower state cannot be read.
        </p>
      </Panel>
    );
  }

  const { config } = status;
  const enabled = config.enabled;
  const decision = status.lastDecision?.action ?? null;

  // Headline banner — what a glance at the card must answer immediately.
  let headline: { text: string; tone: string };
  if (!enabled) {
    headline = { text: "Off — automation is inert", tone: "text-muted" };
  } else if (decision === "shutdown" && status.targets.every((t) => !t.online)) {
    headline = {
      text: `Fleet is off${status.nextWakeAt != null ? ` — auto-wake in ${countdown(status.nextWakeAt, now)}` : ""}`,
      tone: "text-accent",
    };
  } else if (status.watching && decision === "watching" && status.shutdownInMs != null) {
    headline = {
      text: `Watching — idle ${status.idleMin ?? 0} / ${config.idleTimeoutMin} min, shutdown in ${Math.max(0, Math.round(status.shutdownInMs / 60_000))} min`,
      tone: "text-warning",
    };
  } else if (decision === "busy") {
    headline = { text: `Busy — ${status.lastBusyReason ?? "activity detected"}`, tone: "text-muted" };
  } else {
    headline = {
      text: `Armed — next watch: ${DAY_LABEL[status.dayType].toLowerCase()} ${
        config.watch[status.dayType][0]
          ? `${config.watch[status.dayType][0].start} → ${config.watch[status.dayType][0].end}`
          : "none set"
      }`,
      tone: "text-accent",
    };
  }

  return (
    <Panel
      title="Spark AutoPower"
      accent
      icon={
        <span
          className={`h-2 w-2 shrink-0 rounded-full ${
            enabled ? "bg-accent dot-glow-success" : "bg-border"
          }`}
        />
      }
      className="flex flex-col"
      bodyClassName="flex flex-1 flex-col space-y-3"
      actions={
        <div className="flex flex-wrap items-center justify-end gap-2">
          <span className="text-[11px] text-muted tabular-nums">
            {enabled ? "Auto ON" : "Auto OFF"}
          </span>
          <button
            type="button"
            role="switch"
            aria-checked={enabled}
            onClick={() => void toggleEnabled()}
            className={`toggle-track relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${
              enabled ? "bg-accent" : "bg-border"
            }`}
            title={enabled ? "Disable AutoPower" : "Enable AutoPower"}
          >
            <span
              className={`toggle-dot inline-block h-4 w-4 transform rounded-full shadow transition-transform ${
                enabled ? "translate-x-4" : "translate-x-0"
              }`}
            />
          </button>
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] transition-colors ${
              open
                ? "border-accent text-accent"
                : "border-border text-muted hover:border-accent hover:text-accent"
            }`}
            title="Watch / wake schedule"
          >
            <GearIcon className="h-3 w-3" /> Settings
          </button>
        </div>
      }
    >
      <p className={`text-sm font-medium ${headline.tone}`}>{headline.text}</p>

      <div className="flex flex-wrap items-center gap-1.5">
        <SourceBadge
          name="AI proxy"
          ok={status.sources?.proxy.ok ?? null}
          detail={
            status.sources?.proxy.ok
              ? `${(status.sources.proxy.streams ?? 0) + (status.sources.proxy.requests ?? 0)} req`
              : undefined
          }
          error={status.sources?.proxy.error}
        />
        <SourceBadge
          name="Dev engine"
          ok={status.sources?.engine.ok ?? null}
          detail={
            status.sources?.engine.ok
              ? `${status.sources.engine.slotsUsed ?? 0}/${"slots"} · ${status.sources.engine.ticketsActive ?? 0} tickets · ${status.sources.engine.plansActive ?? 0} plans`
              : undefined
          }
          error={status.sources?.engine.error}
        />
        {status.targets.map((t) => (
          <span
            key={t.id}
            className={`inline-flex items-center gap-1.5 rounded border px-1.5 py-0.5 text-[11px] ${
              t.online ? "border-border text-text" : "border-border text-muted"
            }`}
            title={t.online ? `${t.name} is online` : `${t.name} is offline`}
          >
            <span className={`h-1.5 w-1.5 rounded-full ${t.online ? "dot-glow-success bg-success" : "bg-border"}`} />
            {t.name}
          </span>
        ))}
        {status.nextWakeAt != null && enabled && (
          <span
            className="inline-flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[11px] text-muted"
            title={`Scheduled auto-wake (WoL), ${config.tz}`}
          >
            wake in <span className="font-tabular text-accent">{countdown(status.nextWakeAt, now)}</span>
          </span>
        )}
        {status.lastAction && (
          <span
            className="text-[11px] text-muted"
            title={`${status.lastAction.reason}\n${status.lastAction.results
              .map((r) => `${r.id}: ${r.ok ? "ok" : `FAILED — ${r.error}`}`)
              .join("\n")}`}
          >
            last: {status.lastAction.kind === "wake" ? "wake" : "shutdown"} at{" "}
            {whenLabel(status.lastAction.at, now)}
          </span>
        )}
      </div>

      {open && (
        <div className="space-y-3 rounded border border-border bg-surface-elevated p-3">
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
            <label className="flex items-center gap-2 text-[11px] text-muted">
              Idle shutdown after
              <input
                type="text"
                inputMode="numeric"
                maxLength={3}
                value={idleMin}
                onChange={(e) => setIdleMin(e.target.value.replace(/\D/g, ""))}
                className="w-12 rounded border border-border bg-surface-elevated px-1.5 py-0.5 font-tabular text-xs text-text outline-none focus:border-accent"
                aria-label="Idle timeout in minutes"
              />
              minutes
            </label>
            <span className="text-[11px] text-muted">
              timezone <span className="text-text">{config.tz}</span>
            </span>
          </div>

          {(Object.keys(DAY_LABEL) as DayType[]).map((day) => (
            <div key={day} className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <div className="flex items-center gap-2 text-[11px] text-muted">
                <span className="w-20 shrink-0 text-text">{DAY_LABEL[day]}</span>
                watch
                <ClockInput
                  value={watch[day].start}
                  onChange={(v) => setWatch((w) => ({ ...w, [day]: { ...w[day], start: v } }))}
                  label={`${DAY_LABEL[day]} watch start`}
                  invalid={triedSave ? badRequiredClock(watch[day].start) : badClock(watch[day].start)}
                />
                →
                <ClockInput
                  value={watch[day].end}
                  onChange={(v) => setWatch((w) => ({ ...w, [day]: { ...w[day], end: v } }))}
                  label={`${DAY_LABEL[day]} watch end`}
                  invalid={triedSave ? badRequiredClock(watch[day].end) : badClock(watch[day].end)}
                />
              </div>
              <div className="flex items-center gap-2 text-[11px] text-muted">
                <span className="w-20 shrink-0 invisible">{DAY_LABEL[day]}</span>
                wake
                <ClockInput
                  value={wake[day]}
                  onChange={(v) => setWake((w) => ({ ...w, [day]: v }))}
                  label={`${DAY_LABEL[day]} wake time`}
                  placeholder="none"
                  invalid={badClock(wake[day])}
                />
                <span className="text-[10px]">WoL; empty = no auto-wake</span>
              </div>
            </div>
          ))}

          <p className="text-[10px] leading-snug text-muted">
            Watch end ≤ start wraps past midnight (22:00 → 07:00 = the night). Sparks shut
            down only when the AI proxy, the dev engine, and the plan queue have all been
            quiet for the full idle span. Unknown (a source unreachable) is treated as
            busy — the dashboard host itself is never powered off.
          </p>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void save()}
              disabled={saving}
              className="btn-accent inline-flex items-center gap-1.5 rounded px-2.5 py-1 text-xs"
            >
              {saving ? "Saving…" : "Save settings"}
            </button>
            {saveErr && <span className="text-[11px] text-danger">{saveErr}</span>}
            {savedAt && now - savedAt < 15_000 && !saveErr && (
              <span className="text-[11px] text-success">Saved ✓</span>
            )}
          </div>
        </div>
      )}
    </Panel>
  );
}
