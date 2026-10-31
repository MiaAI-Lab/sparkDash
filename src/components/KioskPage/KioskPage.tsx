import { memo, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import "../../styles/kiosk.css";
import { fetchFleetEnergy, fetchSettings } from "../../api/client";
import type { FleetEnergy, Settings, SparkSnapshot } from "../../api/types";
import { resolveSparkRole } from "../../api/sparkRole";
import { useSnapshot } from "../../hooks/useSnapshot";
import { useFleetAlerts } from "../../hooks/useFleetAlerts";
import { formatTemperature } from "../../shared/fleetExceptions";
import { formatDiskSize } from "../../shared/formatBytes";
import { headroomTextClass } from "../../shared/vramBreakdown";
import { makeHeadResolver } from "../../shared/sparkHead";
import { formatTokensCompact } from "../../shared/tokenFormat";
import { activeTimeZone, setConfiguredTimeZone } from "../../shared/timeZone";
import { vramContextFor, type VramBreakdownContext } from "../../shared/vramBreakdown";
import { computeFleetTotals } from "../OverviewPage/fleetStats";
import { BoltIcon } from "../ui/icons";
import { kioskCard, kioskColumns, kioskFleetStats, parseKioskOptions, smoothPath, type KioskTraces } from "./kioskModel";
import { useKioskTraces } from "./useKioskTraces";

type TempUnit = "celsius" | "fahrenheit";

const SETTINGS_REFRESH_MS = 5 * 60_000;
const ENERGY_REFRESH_MS = 60_000;
const CURSOR_IDLE_MS = 3_000;
/** Below this width the wall scrolls instead of fitting one screen (a phone or a narrow window). */
const FIT_MIN_WIDTH = 760;
/** Cards on one screen (3 × 2 on a 16:9 wall); a larger fleet keeps their size and scrolls. */
const SCREEN_UNITS = 6;

/** One trace in a chart: values (null = gap), a fixed top of scale, and how it is drawn. */
interface Series {
  key: string;
  label: string;
  values: ReadonlyArray<number | null>;
  max: number;
  dashed?: boolean;
}

/** Overlaid traces with independent scales, drawn as smooth curves; a gap in a series breaks its line. */
function KioskTrace({ series, className = "" }: { series: Series[]; className?: string }) {
  const W = 300;
  const H = 100;
  return (
    <div className={`kiosk-trace ${className}`}>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden>
        {series.map((s) => {
          const n = s.values.length;
          if (n < 2) return null;
          const d = smoothPath(
            s.values.map((v, i) => (v == null ? null : [(i / (n - 1)) * W, H - 2 - (Math.min(s.max, Math.max(0, v)) / s.max) * (H - 6)] as const))
          );
          return d ? (
            <path key={s.key} d={d} className={`kiosk-trace__line kiosk-trace__line--${s.key}${s.dashed ? " is-dashed" : ""}`} vectorEffect="non-scaling-stroke" />
          ) : null;
        })}
      </svg>
      <ul className="kiosk-trace__legend">
        {series.map((s) => (
          <li key={s.key} className={`kiosk-trace__key--${s.key}`}>
            {s.label}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** A scale top for a tok/s trace: its own peak rounded up, never below `floor`. */
function rateScale(values: ReadonlyArray<number | null>, floor = 10): number {
  const peak = Math.max(floor, ...values.map((v) => v ?? 0));
  const mag = 10 ** Math.floor(Math.log10(peak));
  return Math.ceil(peak / mag) * mag;
}

function rateText(v: number | null): string {
  if (v == null) return "—";
  return v >= 100 ? v.toFixed(0) : v.toFixed(1);
}

/** A unit's 30-minute trace inside its card. */
function UnitTrace({ traces }: { traces: KioskTraces | undefined }) {
  const { t } = useTranslation("statistics");
  if (!traces) return <div className="kiosk-card__trace" />;
  const series: Series[] = [
    { key: "gpu", label: t("kiosk.gpu"), values: traces.gpu, max: 100 },
    { key: "cpu", label: t("kiosk.cpu"), values: traces.cpu, max: 100 },
  ];
  if (traces.gen.some((v) => v != null)) series.push({ key: "gen", label: t("kiosk.genRate"), values: traces.gen, max: rateScale(traces.gen) });
  if (traces.prefill.some((v) => v != null)) {
    series.push({ key: "prefill", label: t("kiosk.prefillRate"), values: traces.prefill, max: rateScale(traces.prefill, 100), dashed: true });
  }
  return <KioskTrace series={series} className="kiosk-card__trace" />;
}

function Stat({ label, value, unit, live = false }: { label: string; value: string; unit?: string; live?: boolean }) {
  return (
    <div className="kiosk-stat">
      <span className="kiosk-stat__label">{label}</span>
      <span className={`kiosk-stat__value${live ? " is-live" : ""}`}>
        {value}
        {unit ? <small>{unit}</small> : null}
      </span>
    </div>
  );
}

const pctText = (v: number | null) => (v == null || !Number.isFinite(v) ? "—" : `${Math.round(v)}%`);

/**
 * One unit on the wall: the Overview card's key figures in large type, sized from the grid cell
 * (container query units), so six units read from across a room.
 */
const KioskCardView = memo(function KioskCardView({
  spark,
  headSpark,
  vramContext,
  traces,
  tempUnit,
}: {
  spark: SparkSnapshot;
  headSpark: SparkSnapshot | null;
  vramContext: VramBreakdownContext | null;
  traces: KioskTraces | undefined;
  tempUnit: TempUnit;
}) {
  const { t } = useTranslation("statistics");
  const c = kioskCard(spark, headSpark, vramContext, t);
  const temp = (v: number | null) => (v == null ? "—" : formatTemperature(v, tempUnit));
  return (
    <article className={`kiosk-card${c.online ? "" : " is-offline"}`} aria-label={c.online ? c.name : t("kiosk.offlineAria", { name: c.name })}>
      <div className="kiosk-card__in">
        <header className="kiosk-card__head">
          <span className={`kiosk-dot${c.online ? "" : " is-off"}`} />
          <span className="kiosk-card__name">{c.name}</span>
          {c.role !== "standalone" ? (
            <span className="kiosk-card__role" title={c.workerOf ? t("kiosk.workerOf", { name: c.workerOf.name }) : undefined}>
              {c.workerOf ? t("kiosk.workerOfShort", { name: c.workerOf.name }) : c.role}
            </span>
          ) : null}
          {c.online && c.model ? (
            <span className={`kiosk-card__model${c.model.muted ? " is-muted" : ""}`} title={c.model.ctx ? `${c.model.text} · ${c.model.ctx}` : c.model.text}>
              <code>{c.model.text}</code>
              {c.model.ctx ? <span>{c.model.ctx}</span> : null}
            </span>
          ) : null}
          {c.ip ? <span className="kiosk-card__ip">{c.ip}</span> : null}
        </header>
        {!c.online ? (
          <div className="kiosk-card__offline">
            <span>{t("kiosk.offline")}</span>
            {c.offlineReason ? <small>{c.offlineReason}</small> : null}
          </div>
        ) : (
          <>
            {c.memory ? (
              <div className="kiosk-mem">
                <div className="kiosk-mem__row">
                  <span className="kiosk-mem__label">{c.memory.label}</span>
                  {c.memory.free ? <span className={`kiosk-mem__free ${headroomTextClass(c.memory.tone)}`}>{c.memory.free}</span> : null}
                </div>
                <div className="kiosk-mem__bar">
                  {c.memory.segments.map((seg) => (
                    <span key={seg.key} className={`mem-seg-${seg.key}`} style={{ ["--pct" as string]: `${seg.pct}%` }} />
                  ))}
                </div>
                {c.memory.legend.length || c.memory.ram ? (
                  <div className="kiosk-mem__legend">
                    {c.memory.legend.map((it) => (
                      <span key={it.key}>
                        <i className={`mem-seg-${it.key}`} />
                        {it.label} {it.gb} GB
                      </span>
                    ))}
                    {c.memory.ram ? <span>{t("kiosk.ram", { value: c.memory.ram })}</span> : null}
                  </div>
                ) : null}
              </div>
            ) : null}
            <div className="kiosk-card__stats">
              <Stat label={t("kiosk.gpu")} value={pctText(c.gpuPct)} />
              <Stat label={t("kiosk.cpu")} value={pctText(c.cpuPct)} />
              <Stat label={t("kiosk.gpuTemp")} value={temp(c.gpuTempC)} />
              <Stat label={t("kiosk.cpuTemp")} value={temp(c.cpuTempC)} />
              <Stat label={t("kiosk.gpuPower")} value={c.gpuW == null ? "—" : `${Math.round(c.gpuW)} W`} />
              <Stat label={t("kiosk.diskFree")} value={c.diskFreeMb == null ? "—" : formatDiskSize(c.diskFreeMb)} />
              {c.rates ? (
                <>
                  <Stat label={t("kiosk.decode")} value={c.rates.decode} unit={t("kiosk.tokPerSec")} live={c.rates.decodeLive} />
                  <Stat label={t("kiosk.prefill")} value={c.rates.prefill} unit={c.rates.prefill === t("kiosk.prefilling") ? undefined : t("kiosk.tokPerSec")} />
                </>
              ) : null}
            </div>
            <UnitTrace traces={traces} />
          </>
        )}
      </div>
    </article>
  );
});

function HeadKpi({ value, unit, label, trace, traceKey }: { value: string; unit?: string; label: string; trace?: ReadonlyArray<number | null>; traceKey?: string }) {
  return (
    <div className={`kiosk-kpi${trace ? " has-trace" : ""}`}>
      {trace && traceKey ? <KioskTrace series={[{ key: traceKey, label: "", values: trace, max: rateScale(trace, 1) }]} className="kiosk-kpi__trace" /> : null}
      <div className="kiosk-kpi__value">
        {value}
        {unit ? <small>{unit}</small> : null}
      </div>
      <div className="kiosk-kpi__label">{label}</div>
    </div>
  );
}

/** Sum per-minute series across units; a minute no unit reported stays a gap. */
function sumTraces(all: ReadonlyArray<ReadonlyArray<number | null>>): Array<number | null> {
  const n = Math.max(0, ...all.map((a) => a.length));
  return Array.from({ length: n }, (_, i) => {
    let sum: number | null = null;
    for (const a of all) if (a[i] != null) sum = (sum ?? 0) + (a[i] as number);
    return sum;
  });
}

function useClock(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = window.setInterval(() => setNow(new Date()), 1_000);
    return () => window.clearInterval(t);
  }, []);
  return now;
}

/** Keep the screen awake while the wall is visible; the lock is dropped whenever the tab is hidden. */
function useWakeLock() {
  useEffect(() => {
    const nav = navigator as Navigator & { wakeLock?: { request(type: "screen"): Promise<{ release(): Promise<void> }> } };
    if (!nav.wakeLock) return;
    let lock: { release(): Promise<void> } | null = null;
    let done = false;
    const take = () => {
      if (document.visibilityState !== "visible") return;
      nav.wakeLock!.request("screen").then(
        (l) => {
          if (done) void l.release();
          else lock = l;
        },
        () => {
          /* refused (battery saver, no user gesture): the wall still works */
        }
      );
    };
    take();
    document.addEventListener("visibilitychange", take);
    return () => {
      done = true;
      document.removeEventListener("visibilitychange", take);
      void lock?.release();
    };
  }, []);
}

/** Hide the cursor after a few seconds without movement; `true` while it is shown. */
function useCursorActive(): boolean {
  const [active, setActive] = useState(true);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => {
    const poke = () => {
      setActive(true);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setActive(false), CURSOR_IDLE_MS);
    };
    poke();
    window.addEventListener("mousemove", poke);
    window.addEventListener("touchstart", poke);
    return () => {
      window.removeEventListener("mousemove", poke);
      window.removeEventListener("touchstart", poke);
      window.clearTimeout(timer.current);
    };
  }, []);
  return active;
}

/**
 * /kiosk: a wall display with no menus — fleet totals, a large-type card per unit with its
 * 30-minute trace, and the active alerts.
 * It never dims or reflows for a slow or failed fetch: it holds its last good frame and
 * says how old it is.
 */
export function KioskPage() {
  const { t } = useTranslation("statistics");
  const options = useMemo(() => parseKioskOptions(window.location.search), []);
  const { sparks, connected, lastValidSnapshotAt, refreshInterval, serverAlerts } = useSnapshot();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [energy, setEnergy] = useState<FleetEnergy | null>(null);
  const [size, setSize] = useState(() => ({ w: window.innerWidth, h: window.innerHeight }));
  const now = useClock();
  const cursorActive = useCursorActive();
  useWakeLock();

  useEffect(() => {
    if (options.theme) document.documentElement.setAttribute("data-theme", options.theme);
  }, [options.theme]);

  useEffect(() => {
    document.title = t("kiosk.documentTitle");
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") window.location.href = "/";
    };
    const onResize = () => setSize({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onResize);
    };
  }, [t]);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      fetchSettings()
        .then((s) => {
          if (cancelled) return;
          setConfiguredTimeZone(s.timeZone);
          setSettings(s);
        })
        .catch(() => {
          /* keep the last settings */
        });
    void load();
    const t = window.setInterval(load, SETTINGS_REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(t);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      fetchFleetEnergy()
        .then((e) => {
          if (!cancelled) setEnergy(e);
        })
        .catch(() => {
          /* keep the last reading */
        });
    void load();
    const t = window.setInterval(load, ENERGY_REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(t);
    };
  }, []);

  const tempUnit: TempUnit = settings?.temperatureUnit === "fahrenheit" ? "fahrenheit" : "celsius";
  const shown = useMemo(() => (settings?.hideWorkers ? sparks.filter((s) => resolveSparkRole(s) !== "worker") : sparks), [sparks, settings?.hideWorkers]);
  const totals = useMemo(() => computeFleetTotals(sparks), [sparks]);
  const stats = useMemo(() => kioskFleetStats(sparks), [sparks]);
  const traces = useKioskTraces(sparks);
  const alerts = useFleetAlerts({ sparks, alertsEnabled: Boolean(settings?.alertsEnabled), serverAlerts, temperatureUnit: tempUnit });

  const fleetGen = useMemo(() => sumTraces(Object.values(traces).map((t) => t.gen)), [traces]);
  const showBreakdown = settings?.showVramBreakdown !== false;
  // Head lookup and memory-breakdown inputs for every card in one pass, as the Overview does.
  const cardContext = useMemo(() => {
    const resolveHead = makeHeadResolver(sparks);
    const byId = new Map<string, { head: SparkSnapshot | null; vram: VramBreakdownContext | null }>();
    for (const spark of sparks) {
      byId.set(spark.id, { head: resolveHead(spark), vram: showBreakdown ? vramContextFor(spark, sparks, resolveHead) : null });
    }
    return byId;
  }, [sparks, showBreakdown]);
  const fitScreen = options.fit === "shrink" && size.w >= FIT_MIN_WIDTH;
  // One screen holds up to SCREEN_UNITS cards; a larger fleet keeps that card size and scrolls by rows.
  // The grid sits below the header; its share of the window is close enough to choose columns by.
  const perScreen = Math.min(shown.length, SCREEN_UNITS);
  const cols = options.cols || kioskColumns(perScreen, size.w, size.h * 0.82);
  const rowsOnScreen = Math.max(1, Math.ceil(perScreen / cols));
  const scrolls = fitScreen && shown.length > cols * rowsOnScreen;
  const staleAfterMs = Math.max(10_000, 3 * (refreshInterval ?? 2_000));
  const stale = lastValidSnapshotAt != null && now.getTime() - lastValidSnapshotAt > staleAfterMs;
  const tz = activeTimeZone();
  const clock = now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", timeZone: tz });
  const date = now.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric", timeZone: tz });

  return (
    <div className={`kiosk kiosk--${options.fit}${cursorActive ? "" : " is-idle"}`}>
      <header className="kiosk-head">
        <a href="/" className="kiosk-brand" title={t("kiosk.back")}>
          <span className="brand__mark">
            <BoltIcon className="h-[17px] w-[17px]" />
          </span>
          <span>
            spark<span className="brand__dash">Dash</span>
          </span>
        </a>
        <HeadKpi value={rateText(totals.decodeTps)} label={t("kiosk.fleetDecode")} trace={fleetGen} traceKey="gen" />
        <HeadKpi value={totals.powerW.toFixed(0)} unit="W" label={t("kiosk.gpuPower")} />
        <HeadKpi value={stats.gpuTempMaxC == null ? "—" : formatTemperature(stats.gpuTempMaxC, tempUnit)} label={t("kiosk.hottestGpu")} />
        <HeadKpi value={stats.queued == null ? "—" : String(stats.queued)} label={t("kiosk.queued")} />
        <HeadKpi
          value={energy?.energy24hKwh == null ? "—" : energy.energy24hKwh.toFixed(1)}
          unit="kWh"
          label={energy?.estimated ? t("kiosk.energyEstimated") : t("kiosk.energy24h")}
        />
        <HeadKpi value={energy ? formatTokensCompact(energy.outputTokens24h) : "—"} label={t("kiosk.tokens24h")} />
        <HeadKpi value={`${stats.online}/${stats.total}`} label={t("kiosk.online")} />
        <div className="kiosk-clock">
          <div className="kiosk-clock__time">{clock}</div>
          <div className="kiosk-clock__date">{date}</div>
          {!connected || stale ? (
            <div className="kiosk-clock__stale">
              {lastValidSnapshotAt
                ? t("kiosk.stale", { time: new Date(lastValidSnapshotAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", timeZone: tz }) })
                : t("kiosk.connecting")}
            </div>
          ) : null}
        </div>
      </header>
      <main className={`kiosk-frame${fitScreen ? " is-fit" : ""}${scrolls ? " is-scrolling" : ""}`}>
        <div className="kiosk-grid" style={{ ["--kiosk-cols" as string]: cols, ["--kiosk-rows" as string]: rowsOnScreen }}>
          {shown.map((s) => {
            const ctx = cardContext.get(s.id);
            return <KioskCardView key={s.id} spark={s} headSpark={ctx?.head ?? null} vramContext={ctx?.vram ?? null} traces={traces[s.id]} tempUnit={tempUnit} />;
          })}
        </div>
      </main>
      {alerts.ready && alerts.rows.length ? (
        <section className="kiosk-alerts" aria-label={t("kiosk.activeAlerts")}>
          {alerts.rows.map((a) => (
            <span key={a.key} className={`kiosk-alert is-${a.severity}`}>
              <b>{a.unitName}</b> {a.label}
            </span>
          ))}
        </section>
      ) : null}
    </div>
  );
}
