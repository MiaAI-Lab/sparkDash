import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useModalPresence } from "../../hooks/useModalPresence";
import { fetchAutoPower, updateAutoPowerConfig } from "../../api/client";
import type { AutoPowerStatus } from "../../api/types";
import { Panel } from "../ui/Panel";
import { GearIcon, MoonStarIcon, RotateIcon } from "../ui/icons";
import type { DayType } from "../../shared/modelSchedules";
import type { EngineLive, IdleFeed, ProxyLive } from "../../shared/idleCounts";
import { liveBusyReasons } from "../../shared/idleCounts";

const DAY_LABEL: Record<DayType, string> = { weekday: "Workdays", weekend: "Weekend" };

const POLL_MS = 5_000;

/** "in 42 min" / "in 1 h 40 min". */
function countdown(epochMs: number, nowMs: number): string {
  const mins = Math.max(0, Math.round((epochMs - nowMs) / 60_000));
  if (mins < 60) return `${mins} min`;
  return `${Math.floor(mins / 60)} h ${mins % 60} min`;
}

/** "14:05" / "yesterday 22:41" — human memory for the last action. */
function whenLabel(epochMs: number, nowMs: number): string {
  const d = new Date(epochMs);
  const clock = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
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

/**
 * Spark AutoPower Overview card.
 *
 * Watches the AI proxy (in-flight requests) and the dev engine (slots,
 * tickets, plan runs). After the configured idle span of verified quiet
 * inside the watch window, the remote Sparks are shut down; at the wake
 * time a WoL magic packet brings them back. The shutdown DECISION is made
 * server-side on its own 30 s tick (it must fire with no browser open).
 *
 * The displayed live counts, though, are NOT queried here — they are
 * published by the AI Proxy / Dev Engine panels on their own 5 s poll
 * (lifted to OverviewPage), so this card shows exactly what those widgets
 * show, with zero timing skew between them.
 *
 * Header actions and the settings modal follow the Model Launcher:
 * bordered-chip buttons, a chip-state switch, and a modal-sheet dialog.
 */
export function AutoPowerPanel({
  proxyIdle,
  engineIdle,
}: {
  /** AI Proxy panel's latest published counts (null until its first poll). */
  proxyIdle?: ProxyLive | null;
  /** Dev Engine panel's latest published counts (null until its first poll). */
  engineIdle?: EngineLive | null;
} = {}) {
  const [status, setStatus] = useState<AutoPowerStatus | null | undefined>(undefined);
  const [now, setNow] = useState(() => Date.now());
  const [dialogOpen, setDialogOpen] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setStatus(await fetchAutoPower());
    } catch {
      setStatus(null); // server unreachable — graceful degrade
    }
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(t);
  }, [refresh]);

  // Local countdown clock (payloads carry absolute epochs; this only renders).
  useEffect(() => {
    // 5 s: matches the widgets' publish cadence so "updated Ns ago" stays exact.
    const t = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(t);
  }, []);

  const [toggleErr, setToggleErr] = useState<string | null>(null);

  const toggleEnabled = useCallback(async () => {
    if (!status) return;
    setToggleErr(null);
    try {
      await updateAutoPowerConfig({ enabled: !status.config.enabled });
      void refresh();
    } catch (err) {
      setToggleErr(err instanceof Error ? err.message : "Toggle failed");
    }
  }, [status, refresh]);

  // ── Degrade states ────────────────────────────────────────
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

  // Live counters mirrored from the two widgets (see header comment).
  const feed: IdleFeed = { proxy: proxyIdle ?? null, engine: engineIdle ?? null };
  const liveAt = Math.max(proxyIdle?.at ?? 0, engineIdle?.at ?? 0);

  // Headline — a quiet one-liner (Model Launcher whisper style), never a banner.
  let headline: { text: string; tone: string };
  if (!enabled) {
    headline = { text: "off — automation is inert", tone: "text-muted" };
  } else if (decision === "shutdown" && status.targets.every((t) => !t.online)) {
    headline = {
      text: `fleet is off${status.nextWakeAt != null ? `, auto-wake in ${countdown(status.nextWakeAt, now)}` : ""}`,
      tone: "text-accent",
    };
  } else if (status.watching && decision === "watching" && status.shutdownInMs != null) {
    headline = {
      text: `idle ${status.idleMin ?? 0}/${config.idleTimeoutMin} min — shutdown in ${Math.max(0, Math.round(status.shutdownInMs / 60_000))} min`,
      tone: "text-warning",
    };
  } else if (decision === "busy") {
    headline = { text: `busy — ${liveBusyReasons(feed)[0] ?? status.lastBusyReason ?? "activity"}`, tone: "text-muted" };
  } else {
    headline = {
      text: `next watch: ${DAY_LABEL[status.dayType].toLowerCase()} ${
        config.watch[status.dayType][0]
          ? `${config.watch[status.dayType][0].start} → ${config.watch[status.dayType][0].end}`
          : "none set"
      }`,
      tone: "text-muted",
    };
  }

  return (
    <>
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
        bodyClassName="flex flex-1 flex-col"
        actions={
          <div className="flex flex-wrap items-center justify-end gap-1.5">
            {/* Chip-state switch + chip buttons — the Model Launcher header kit. */}
            <button
              type="button"
              role="switch"
              aria-checked={enabled}
              onClick={() => void toggleEnabled()}
              title={
                enabled
                  ? "AutoPower ON — shutdown + wake fire on schedule; click to make them inert"
                  : "AutoPower OFF — nothing shuts down or wakes on its own"
              }
              className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] transition-colors ${
                enabled
                  ? "border-accent/50 bg-accent/10 text-accent"
                  : "border-border text-muted hover:text-text"
              }`}
            >
              Auto {enabled ? "on" : "off"}
            </button>
            <button
              type="button"
              onClick={() => setDialogOpen(true)}
              className="inline-flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[11px] text-muted transition-colors hover:border-accent hover:text-accent"
              title="Watch / wake schedule"
            >
              <GearIcon className="h-3 w-3" /> Settings
            </button>
          </div>
        }
      >
        <p className={`text-[14px] leading-snug mb-[10px] ${headline.tone}`}>{headline.text}</p>
        {toggleErr && <p className="text-[11px] text-danger mb-[10px]">{toggleErr}</p>}

        <div className="flex flex-wrap items-center gap-1.5">
          {/* Live counts come from the two widgets (published on their own
              5 s poll, lifted to OverviewPage). Server sources is the fallback
              when the panels are unmounted, so the badge is never blind. */}
          <SourceBadge
            name="AI proxy"
            ok={proxyIdle ? proxyIdle.ok : (status.sources?.proxy.ok ?? null)}
            detail={
              (proxyIdle ? proxyIdle.ok : status.sources?.proxy.ok)
                ? `${((proxyIdle?.streams ?? status.sources?.proxy.streams) ?? 0) + ((proxyIdle?.requests ?? status.sources?.proxy.requests) ?? 0)} req`
                : undefined
            }
            error={
              proxyIdle && !proxyIdle.ok
                ? "unreachable (from AI Proxy panel)"
                : !proxyIdle && status.sources?.proxy.ok === false
                  ? status.sources?.proxy.error
                  : undefined
            }
          />
          <SourceBadge
            name="Dev engine"
            ok={engineIdle ? engineIdle.ok : (status.sources?.engine.ok ?? null)}
            detail={
              (engineIdle ? engineIdle.ok : status.sources?.engine.ok)
                ? `${(engineIdle?.slotsUsed ?? status.sources?.engine.slotsUsed) ?? 0} slots · ${(engineIdle?.ticketsActive ?? status.sources?.engine.ticketsActive) ?? 0} tickets · ${(engineIdle?.plansActive ?? status.sources?.engine.plansActive) ?? 0} plans`
                : undefined
            }
            error={
              engineIdle && !engineIdle.ok
                ? "unreachable (from Dev Engine panel)"
                : !engineIdle && status.sources?.engine.ok === false
                  ? status.sources?.engine.error
                  : undefined
            }
          />
          {liveAt > 0 && (
            <span
              className="text-[11px] text-muted"
              title={`Live counts mirrored from the AI Proxy / Dev Engine panels (own 5 s poll), updated ${whenLabel(liveAt, now)}`}
            >
              updated{" "}
              <span className="font-tabular">{Math.max(0, Math.round((now - liveAt) / 1000))}s ago</span>
            </span>
          )}
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
      </Panel>

      <AutoPowerSettingsDialog
        open={dialogOpen}
        config={config}
        onClose={() => setDialogOpen(false)}
      />
    </>
  );
}

/**
 * Settings modal — shape cloned from ModelScheduleDialog: modal-sheet with
 * header/body/footer, per-day bordered blocks, inline danger box, and a
 * solid-accent Save next to a bordered Close.
 */
function AutoPowerSettingsDialog({
  open,
  config,
  onClose,
}: {
  open: boolean;
  config: AutoPowerStatus["config"];
  onClose: () => void;
}) {
  const { mounted, visible } = useModalPresence(open);

  const [idleMin, setIdleMin] = useState("30");
  const [watch, setWatch] = useState<Record<DayType, { start: string; end: string }>>({
    weekday: { start: "22:00", end: "07:00" },
    weekend: { start: "23:00", end: "08:00" },
  });
  const [wake, setWake] = useState<Record<DayType, string>>({ weekday: "", weekend: "" });
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [triedSave, setTriedSave] = useState(false);
  const [saved, setSaved] = useState(false);

  // Server owns the truth: re-seed the draft each time the dialog opens.
  useEffect(() => {
    if (!open) return;
    const w = config.watch;
    setIdleMin(String(config.idleTimeoutMin));
    setWatch({
      weekday: w.weekday[0] ? { start: w.weekday[0].start, end: w.weekday[0].end } : { start: "", end: "" },
      weekend: w.weekend[0] ? { start: w.weekend[0].start, end: w.weekend[0].end } : { start: "", end: "" },
    });
    setWake({ weekday: config.wake.weekday ?? "", weekend: config.wake.weekend ?? "" });
    setSaveErr(null);
    setTriedSave(false);
    setSaved(false);
  }, [open, config]);

  // Escape + backdrop close (same ergonomics as the model dialogs).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  const anyInvalid =
    badRequiredClock(watch.weekday.start) ||
    badRequiredClock(watch.weekday.end) ||
    badRequiredClock(watch.weekend.start) ||
    badRequiredClock(watch.weekend.end) ||
    badClock(wake.weekday) ||
    badClock(wake.weekend);

  const handleSave = async () => {
    setTriedSave(true);
    setSaving(true);
    setSaveErr(null);
    setSaved(false);
    try {
      await updateAutoPowerConfig({
        idleTimeoutMin: Number(idleMin),
        watch: {
          weekday: [{ start: watch.weekday.start.trim(), end: watch.weekday.end.trim() }],
          weekend: [{ start: watch.weekend.start.trim(), end: watch.weekend.end.trim() }],
        },
        wake: {
          weekday: wake.weekday.trim() || null,
          weekend: wake.weekend.trim() || null,
        },
      });
      setSaved(true);
    } catch (err) {
      setSaveErr(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  if (!mounted) return null;

  const error = saveErr;

  return createPortal(
    <div
      className={`modal-overlay${visible ? " is-open" : ""}`}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal-sheet max-w-md" role="dialog" aria-modal="true" aria-labelledby="autopower-settings-title">
        <header className="modal-sheet__header" id="autopower-settings-title">
          <div className="flex items-center gap-2">
            <MoonStarIcon className="h-4 w-4 shrink-0 text-accent" />
            <span>AutoPower settings</span>
          </div>
          <p className="mt-1 text-xs font-normal text-muted">
            timezone <span className="text-text">{config.tz}</span> · idle 0 on the proxy and
            the engine for the set span, inside the window, shuts the Sparks down
          </p>
        </header>

        <div className="modal-sheet__body space-y-4">
          <div className="flex items-center justify-between rounded-md border border-border bg-surface-elevated px-3 py-2">
            <span className="text-xs text-text">Shut down after</span>
            <label className="flex items-center gap-1.5 text-xs text-muted">
              <input
                type="text"
                inputMode="numeric"
                maxLength={3}
                value={idleMin}
                onChange={(e) => setIdleMin(e.target.value.replace(/\D/g, ""))}
                className="w-12 rounded border border-border bg-surface-elevated px-1.5 py-0.5 font-tabular text-xs text-text outline-none focus:border-accent"
                aria-label="Idle timeout in minutes"
              />
              minutes idle
            </label>
          </div>

          {(Object.keys(DAY_LABEL) as DayType[]).map((day) => (
            <div key={day} className="space-y-2 rounded-md border border-border bg-surface-elevated p-3">
              <p className="text-[11px] uppercase tracking-wide text-muted">{DAY_LABEL[day]}</p>
              <div className="flex items-center gap-2 text-[11px] text-muted">
                <span className="w-12 shrink-0">watch</span>
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
                <span className="text-[10px]">quiet-watch window; end ≤ start wraps midnight</span>
              </div>
              <div className="flex items-center gap-2 text-[11px] text-muted">
                <span className="w-12 shrink-0">wake</span>
                <ClockInput
                  value={wake[day]}
                  onChange={(v) => setWake((w) => ({ ...w, [day]: v }))}
                  label={`${DAY_LABEL[day]} wake time`}
                  placeholder="none"
                  invalid={badClock(wake[day])}
                />
                <span className="text-[10px]">Wake-on-LAN; empty = no auto-wake</span>
              </div>
            </div>
          ))}

          {error && (
            <div className="rounded-md border border-danger/40 bg-danger/10 p-3">
              <p className="text-[11px] text-danger">{error}</p>
            </div>
          )}

          <p className="text-[11px] leading-relaxed text-muted">
            Sparks shut down only when the AI proxy, the dev engine, and the plan queue have
            all been quiet for the full idle span. An unreachable source counts as busy —
            the dashboard host itself is never powered off.
          </p>
        </div>

        <div className="modal-sheet__footer">
          <div className="modal-sheet__footer-actions" style={{ marginLeft: "auto" }}>
            {saving && <RotateIcon className="h-3 w-3 animate-spin text-muted" />}
            {saved && <span className="text-xs text-success">Saved ✓</span>}
            <button
              type="button"
              onClick={onClose}
              disabled={saving}
              className="rounded border border-border px-3 py-1.5 text-xs text-muted transition-colors hover:bg-surface-hover hover:text-text disabled:opacity-50"
            >
              Close
            </button>
            <button
              type="button"
              onClick={() => void handleSave()}
              disabled={saving || (triedSave && anyInvalid)}
              className="rounded bg-accent px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-accent-hover disabled:opacity-50"
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
