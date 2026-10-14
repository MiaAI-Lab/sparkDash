import { useCallback, useEffect, useId, useState } from "react";
import { createPortal } from "react-dom";
import {
  fetchClockCap,
  fetchFleetClockAuto,
  setClockCap,
  setFleetClockAuto,
} from "../api/client";
import type {
  ClockCapResult,
  ClockCapSparkStatus,
  FleetClockAutoState,
  SparkSnapshot,
} from "../api/types";
import { useModalPresence } from "../hooks/useModalPresence";
import { useFocusTrap } from "../hooks/useFocusTrap";
import { Panel } from "./ui/Panel";
import { Tag } from "./ui/Tag";
import { GaugeIcon, RotateIcon, XIcon } from "./ui/icons";

/** Preset caps in MHz. The server rejects anything outside this exact list. */
const PRESETS = [1800, 1900, 2000, 2100, 2200, 2300, 2400];

/** How often the (cheap, in-memory) auto-mode status is re-read. */
const AUTO_POLL_MS = 15_000;

interface FleetClockCapProps {
  /** The fleet snapshot — per-Spark readouts (name, live GPU temp) come from here. */
  sparks: SparkSnapshot[];
}

function tempOf(spark: SparkSnapshot): number | null {
  const temp = spark.metrics.gpu?.temperature;
  return typeof temp === "number" && Number.isFinite(temp) ? temp : null;
}

export function FleetClockCap({ sparks }: FleetClockCapProps) {
  const [statuses, setStatuses] = useState<ClockCapSparkStatus[]>([]);
  const [capLoading, setCapLoading] = useState(true);
  const [applying, setApplying] = useState(false);
  const [pendingMhz, setPendingMhz] = useState<number | null | undefined>(undefined);
  const [failures, setFailures] = useState<ClockCapResult[]>([]);
  const [auto, setAuto] = useState<FleetClockAutoState | null>(null);
  const [autoBusy, setAutoBusy] = useState(false);
  const [autoError, setAutoError] = useState<string | null>(null);
  const titleId = useId();
  const { mounted, visible } = useModalPresence(pendingMhz !== undefined);
  const trapRef = useFocusTrap(mounted);

  const refreshCaps = useCallback(async () => {
    setCapLoading(true);
    try {
      const res = await fetchClockCap();
      setStatuses(res.sparks ?? []);
    } catch {
      // Per-Spark readouts are display-only; the next manual refresh retries.
    } finally {
      setCapLoading(false);
    }
  }, []);

  const refreshAuto = useCallback(async () => {
    try {
      setAuto(await fetchFleetClockAuto());
      setAutoError(null);
    } catch (err) {
      setAutoError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refreshCaps();
    void refreshAuto();
    const timer = setInterval(() => void refreshAuto(), AUTO_POLL_MS);
    return () => clearInterval(timer);
  }, [refreshCaps, refreshAuto]);

  const statusById = new Map(statuses.map((s) => [s.id, s]));
  const autoById = new Map((auto?.sparks ?? []).map((s) => [s.id, s]));

  // Preselect the real state on load. The caps come from the fresh
  // GET /api/sparks/clock-cap read: one shared value → that preset (or
  // Unlocked) is highlighted; differing nodes → "Mixed". Auto shows on while
  // the fleet controller is enabled.
  const okStatuses = statuses.filter((s) => s.ok);
  const caps = okStatuses.map((s) => s.mhz);
  const firstCap = caps[0];
  const mixed = caps.length > 1 && caps.some((mhz) => mhz !== firstCap);
  const uniformCap = !mixed && caps.length > 0 ? firstCap : undefined;
  const autoOn = auto?.enabled ?? false;

  async function handleApply() {
    if (pendingMhz === undefined) return;
    setApplying(true);
    setFailures([]);
    try {
      const res = await setClockCap("all", pendingMhz);
      const failed = res.results.filter((r) => !r.ok);
      // Fold the fresh marker state per node into the readouts.
      setStatuses((prev) => {
        const map = new Map(prev.map((s) => [s.id, s]));
        for (const r of res.results) {
          const existing = map.get(r.id);
          map.set(r.id, {
            id: r.id,
            name: r.name,
            ok: r.ok,
            mhz: r.ok ? r.mhz ?? null : existing?.mhz ?? null,
            stale: r.ok ? r.stale ?? false : existing?.stale ?? false,
            graphicsClockMHz: r.ok ? r.graphicsClockMHz ?? null : existing?.graphicsClockMHz ?? null,
            error: r.ok ? undefined : r.error,
          });
        }
        return [...map.values()];
      });
      if (failed.length > 0) {
        setFailures(failed);
      } else {
        setPendingMhz(undefined);
      }
    } catch (err) {
      setFailures([
        { id: "all", name: "every Spark", ok: false, error: err instanceof Error ? err.message : String(err) },
      ]);
    } finally {
      setApplying(false);
    }
  }

  async function handleAuto(enabled: boolean, capMhz?: number) {
    setAutoBusy(true);
    setAutoError(null);
    try {
      setAuto(await setFleetClockAuto(enabled, capMhz));
    } catch (err) {
      setAutoError(err instanceof Error ? err.message : String(err));
    } finally {
      setAutoBusy(false);
    }
  }

  const capButton = (mhz: number | null) => {
    // The preset matching the fleet's real state is highlighted
    // (Unlocked when every node reports stock); "Mixed" shows when nodes differ.
    const active = !capLoading && uniformCap !== undefined && uniformCap === mhz;
    return (
      <button
        key={mhz === null ? "unlocked" : mhz}
        type="button"
        className={active ? "is-on" : undefined}
        aria-pressed={active}
        disabled={applying || capLoading}
        onClick={() => setPendingMhz(mhz)}
        title={
          mhz === null
            ? "Remove the cap on every Spark (nvidia-smi -rgc) and delete the markers"
            : `Apply a ${mhz} MHz clock cap on every Spark`
        }
      >
        {mhz === null ? "Unlocked" : mhz}
      </button>
    );
  };

  return (
    <Panel
      title="GPU clock cap"
      icon={<GaugeIcon className="h-3.5 w-3.5 text-muted" />}
      hint="One control for the whole fleet: caps or unlocks the GPU graphics clock on every Spark via nvidia-smi; Auto holds a cap while a GPU is hot and releases it when it cools."
    >
      <div className="ov-cap">
        {auto ? (
          <div className="ov-cap__auto">
            <div className="ov-cap__autorow">
              <button
                type="button"
                className={`seg ov-cap__toggle ${autoOn ? "is-on" : ""}`}
                aria-pressed={autoOn}
                disabled={autoBusy}
                onClick={() => void handleAuto(!autoOn)}
                title={
                  autoOn
                    ? "Disable fleet-wide auto mode (caps already applied stay until Unlocked)"
                    : "Enable fleet-wide auto mode: hold a cap while a GPU is ≥72 °C, release at ≤67 °C"
                }
              >
                {autoBusy ? <RotateIcon className="h-3 w-3 animate-spin" /> : null}
                Auto {autoOn ? "on" : "off"}
              </button>
              <label className="ov-cap__capselect">
                <span className="text-xs text-muted" title="Auto-only: with Auto off, changing the hold cap applies nothing to the GPUs">
                  Hold cap (Auto only)
                </span>
                <select
                  value={auto.capMhz}
                  disabled={autoBusy}
                  onChange={(e) => void handleAuto(auto.enabled, parseInt(e.target.value, 10))}
                  aria-label="Auto-mode hold cap"
                >
                  {auto.presets.map((mhz) => (
                    <option key={mhz} value={mhz}>
                      {mhz} MHz
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <p className="text-xs text-muted">
              Holds <b className="mono">{auto.capMhz} MHz</b> on any GPU at ≥{auto.holdTempC} °C,
              releases at ≤{auto.releaseTempC} °C (range {auto.range.min}–{auto.range.max} MHz). The
              hold cap is Auto-only — with Auto off, changing it applies nothing to the GPUs.
            </p>
          </div>
        ) : (
          <p className="text-xs text-muted">
            {autoError ? `Auto mode unavailable: ${autoError}` : "Loading auto mode…"}
          </p>
        )}

        <div className="ov-cap__row">
          <span className="text-xs text-muted">
            Fleet presets{mixed ? " — " : ""}
            {mixed ? <Tag tone="warn">Mixed</Tag> : null}
          </span>
          <div className="seg ov-cap__presets" role="group" aria-label="Fleet clock cap preset">
            {PRESETS.map((mhz) => capButton(mhz))}
            {capButton(null)}
          </div>
        </div>

        {failures.length > 0 ? (
          <div className="danger-box" role="alert">
            <b>Clock cap failed</b>
            <ul>
              {failures.map((f, i) => (
                <li key={`${f.id}-${i}`}>{f.name || f.id}{f.error ? `: ${f.error}` : ""}</li>
              ))}
            </ul>
          </div>
        ) : null}

        <div className="ov-cap__list" aria-label="Per-Spark cap status">
          {sparks.map((spark) => {
            const status = statusById.get(spark.id);
            const autoState = autoById.get(spark.id);
            const temp = tempOf(spark);
            return (
              <div key={spark.id} className="ov-cap__spark">
                <span className="ov-cap__name">{spark.name || spark.id}</span>
                <span className="mono text-xs">{temp != null ? `${Math.round(temp)} °C` : "—"}</span>
                {autoState?.holding ? <Tag tone="warn">auto hold</Tag> : null}
                {status ? (
                  status.ok ? (
                    <Tag tone={status.mhz != null ? "acc" : "neutral"}>
                      {status.mhz != null ? `${status.mhz} MHz` : "Unlocked"}
                    </Tag>
                  ) : (
                    <Tag tone="neutral" title={status.error}>status unavailable</Tag>
                  )
                ) : (
                  <span className="text-xs text-muted">
                    {capLoading ? <RotateIcon className="h-3 w-3 animate-spin" /> : "—"}
                  </span>
                )}
              </div>
            );
          })}
          {sparks.length === 0 ? <p className="text-xs text-muted">No Sparks registered.</p> : null}
        </div>
      </div>

      {mounted
        ? createPortal(
            <div
              className={`modal-overlay${visible ? " is-open" : ""}`}
              onClick={(e) => {
                if (applying) return;
                if (e.target === e.currentTarget) setPendingMhz(undefined);
              }}
            >
              <div
                ref={trapRef}
                className="modal-sheet modal-sheet--narrow"
                role="dialog"
                aria-modal="true"
                aria-labelledby={titleId}
              >
                <div className="modal-sheet__header">
                  <div className="modal-sheet__heading">
                    <h2 className="modal-sheet__title" id={titleId}>
                      <GaugeIcon className="h-4 w-4 shrink-0 text-accent" />
                      {pendingMhz === null ? "Remove clock cap" : "Apply clock cap"}
                    </h2>
                    <p className="modal-sheet__sub">
                      {pendingMhz === null
                        ? "Unlocked — revert to stock clocks"
                        : `${pendingMhz} MHz graphics clock cap`}
                    </p>
                  </div>
                  <button
                    type="button"
                    className="modal-sheet__close"
                    onClick={() => setPendingMhz(undefined)}
                    disabled={applying}
                    aria-label="Close"
                  >
                    <XIcon className="h-4 w-4" />
                  </button>
                </div>

                <div className="modal-sheet__body modal-sheet__stack">
                  <p className="modal-sheet__lead">
                    {pendingMhz === null ? "Remove the clock cap on" : "Set the graphics clock cap to"}{" "}
                    <b>every Spark</b>
                    {pendingMhz != null ? <> to <b className="mono">{pendingMhz} MHz</b></> : null}?
                  </p>
                  <p className="text-xs text-muted">
                    Runs nvidia-smi {pendingMhz === null ? "-rgc" : `-lgc 0,${pendingMhz}`} on each
                    Spark over SSH. The cap clears on reboot.
                  </p>
                </div>

                <div className="modal-sheet__footer">
                  <div className="modal-sheet__footer-actions">
                    <button
                      type="button"
                      onClick={() => setPendingMhz(undefined)}
                      disabled={applying}
                      className="btn btn--ghost"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleApply()}
                      disabled={applying}
                      className="btn btn--primary"
                    >
                      {applying ? <RotateIcon className="h-3.5 w-3.5 animate-spin" /> : null}
                      {applying ? "Applying…" : pendingMhz === null ? "Unlocked — confirm" : `Set ${pendingMhz} MHz`}
                    </button>
                  </div>
                </div>
              </div>
            </div>,
            document.body
          )
        : null}
    </Panel>
  );
}
