import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { getClockCapBounds, setClockCap } from "../../api/client";
import type { ClockCapBoundsResponse, ClockCapDomain, ClockCapResponse } from "../../api/types";
import { useModalPresence } from "../../hooks/useModalPresence";
import { useFocusTrap } from "../../hooks/useFocusTrap";
import { InfoIcon } from "../ui/icons";

interface ClockCapControlProps {
  sparkId: string;
  domain: string;
  /** Current cap in MHz, or null when uncapped / unknown. */
  currentMHz: number | null;
  /** Override for the closed-state chip text (defaults to "<n> MHz" / "No cap set"). */
  display?: string;
  /**
   * Truthful provenance note shown on the chip (e.g. the GPU cap is read from
   * the boot unit — this driver exposes no live lock state).
   */
  chipTitle?: string;
  /** False → plain text (control disabled with the server-provided reason). */
  enabled?: boolean;
  disabledReason?: string;
  className?: string;
}

/**
 * Chip family shared with the Throttle OK chip in GpuPanel: same geometry and
 * type, so the Clock Cap row reads as part of the same metric strip.
 */
const CHIP_BASE =
  "shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide";
const CHIP_NEUTRAL = `${CHIP_BASE} border-border bg-surface-elevated text-muted`;
const CHIP_BUTTON = `${CHIP_NEUTRAL} cursor-pointer transition-colors hover:border-accent hover:text-accent`;

function useEscape(enabled: boolean, onClose: () => void) {
  useEffect(() => {
    if (!enabled) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [enabled, onClose]);
}

/**
 * Clickable "Clock Cap" control shared by the GPU and CPU panels. The closed
 * row reads [Modify] [value chip]; both open a dialog offering ONE value in
 * TWO controls — a pure 200 MHz grid range input plus a free-entry number
 * input that is NEVER snapped client-side (the driver quantises clock
 * requests itself, and the apply response reports what it actually set).
 * Candidate chips offer the grid values inside the 0.30–0.80-of-ceiling band;
 * the named specials (Boot default / No cap) live on a separate, visually
 * distinct row so they can never be confused with candidates.
 * No password / sudo prompt exists anywhere by design — provisioning is a
 * one-time helper install (see README "Clock control").
 */
export function ClockCapControl({
  sparkId,
  domain,
  currentMHz,
  display,
  chipTitle,
  enabled = true,
  disabledReason,
  className,
}: ClockCapControlProps) {
  const [open, setOpen] = useState(false);
  const [bounds, setBounds] = useState<ClockCapDomain | null>(null);
  const [boundsWarnings, setBoundsWarnings] = useState<string[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [value, setValue] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ClockCapResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  /**
   * Value the last successful apply PROVED is on the hardware (item 6). Shown
   * in the chip until the server snapshot catches up; null = trust the prop.
   */
  const [confirmedMHz, setConfirmedMHz] = useState<number | null | undefined>(undefined);
  const titleId = useId();
  const { mounted, visible } = useModalPresence(open);
  const trapRef = useFocusTrap(mounted);
  const openedRef = useRef(false);

  useEscape(open && !busy, () => setOpen(false));

  useEffect(() => {
    if (!open) {
      openedRef.current = false;
      setResult(null);
      setError(null);
      return;
    }
    if (openedRef.current) return;
    openedRef.current = true;
    setLoaded(false);
    setLoadError(null);
    setBoundsWarnings([]);
    getClockCapBounds(sparkId)
      .then((res: ClockCapBoundsResponse) => {
        const d = res.domains.find((x) => x.id === domain) ?? null;
        setBounds(d);
        setValue(d?.currentMHz ?? d?.hardMaxMHz ?? null);
        setBoundsWarnings(res.warnings ?? []);
        setLoaded(true);
        if (!d) setLoadError(`Domain ${domain} is not available on this Spark`);
      })
      .catch((err: unknown) => {
        setLoadError(err instanceof Error ? err.message : String(err));
        setLoaded(true);
      });
  }, [open, sparkId, domain]);

  const clamp = useCallback(
    (v: number) => {
      if (!bounds) return v;
      return Math.min(bounds.hardMaxMHz, Math.max(bounds.hardMinMHz, Math.round(v)));
    },
    [bounds]
  );

  const rangeInfo = useMemo(() => {
    if (!bounds) return "";
    return `${bounds.hardMinMHz}–${bounds.hardMaxMHz} MHz`;
  }, [bounds]);

  /**
   * The range input is the pure 200 MHz grid (item 2): aligned hard bounds,
   * step 200, band-limited. Server-computed (one arithmetic source of truth);
   * the fallback mirrors it for responses from an older server.
   */
  const grid = useMemo(() => {
    if (!bounds) return null;
    if (bounds.grid && Number.isFinite(bounds.grid.min) && Number.isFinite(bounds.grid.max) && bounds.grid.max >= bounds.grid.min) {
      return { ...bounds.grid, candidates: bounds.grid.candidates ?? [] };
    }
    const step = 200;
    const min = Math.ceil(bounds.hardMinMHz / step) * step;
    const max = Math.floor(bounds.hardMaxMHz / step) * step;
    const values: number[] = [];
    if (max >= min) for (let v = min; v <= max; v += step) values.push(v);
    return { min: Math.min(min, max), max, step, candidates: values, bandApplied: false };
  }, [bounds]);

  const apply = async (persist: boolean) => {
    if (!bounds || busy) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await setClockCap(sparkId, {
        domain,
        maxMHz: value,
        persist,
      });
      setResult(res);
      // The chip may only ever show a value the hardware confirmed.
      setConfirmedMHz(res.appliedMHz ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const chipMHz = confirmedMHz !== undefined ? confirmedMHz : currentMHz;
  const chipText =
    display ?? (chipMHz != null ? `${chipMHz} MHz` : "No cap set");

  if (!enabled) {
    return (
      <span
        className={`inline-flex items-center gap-1 text-muted ${className ?? ""}`}
        title={disabledReason || "Clock control is disabled (enable it in Edit Spark)"}
      >
        <span className={`font-tabular text-sm text-muted ${chipMHz == null && display == null ? "normal-case" : ""}`}>
          {chipText}
        </span>
        <InfoIcon className="h-3.5 w-3.5" />
      </span>
    );
  }

  return (
    <>
      <button
        type="button"
        className={`${CHIP_BUTTON} ${className ?? ""}`}
        title="Change the clock cap"
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
      >
        Modify
      </button>
      <button
        type="button"
        className={`${CHIP_BUTTON} font-tabular`}
        title={chipTitle ?? "Click to change the clock cap"}
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
      >
        {chipText}
      </button>

      {mounted &&
        createPortal(
          <div
            className={`modal-overlay${visible ? " is-open" : ""}`}
            onClick={(e) => {
              if (busy) return;
              if (e.target === e.currentTarget) setOpen(false);
            }}
          >
            <div
              ref={trapRef}
              className="modal-sheet modal-sheet--clock"
              role="dialog"
              aria-modal="true"
              aria-labelledby={titleId}
            >
              <div className="modal-sheet__header flex items-center gap-2" id={titleId}>
                <span>Clock cap — {bounds?.label ?? domain}</span>
              </div>

              <div className="modal-sheet__body space-y-3 text-sm">
                {!loaded && <p className="text-muted">Reading hardware bounds…</p>}
                {loadError && <p className="text-danger">{loadError}</p>}

                {loaded && bounds && (
                  <>
                    <p className="text-muted">
                      Hardware range: {rangeInfo}. Current:{" "}
                      {chipMHz != null ? `${chipMHz} MHz` : "no cap value reported"}
                      {bounds.unitPath ? ` · boot unit ${bounds.unitPath}` : ""}
                    </p>
                    {boundsWarnings.map((w) => (
                      <p key={w} className="text-warning">
                        {w}
                      </p>
                    ))}

                    {/* One value, two controls (item 2): both write the same
                        state. The range input is the 200 MHz grid; the number
                        input accepts any value in the hardware range and is
                        never snapped to the grid. */}
                    <div className="flex items-center gap-3">
                      <input
                        type="range"
                        min={grid?.min ?? bounds.hardMinMHz}
                        max={grid?.max ?? bounds.hardMaxMHz}
                        step={grid?.step ?? bounds.stepMHz}
                        value={value ?? grid?.min ?? bounds.hardMaxMHz}
                        onChange={(e) => setValue(clamp(Number(e.target.value)))}
                        aria-label="Clock cap in MHz (200 MHz grid)"
                        className="min-w-0 flex-1"
                      />
                      <input
                        type="number"
                        min={bounds.hardMinMHz}
                        max={bounds.hardMaxMHz}
                        value={value ?? ""}
                        onChange={(e) => {
                          const n = parseInt(e.target.value, 10);
                          setValue(Number.isFinite(n) ? clamp(n) : null);
                        }}
                        aria-label="Clock cap in MHz"
                        className="w-20 rounded border border-border bg-surface-elevated px-2 py-1 text-right font-tabular text-xs text-text outline-none focus:border-accent"
                      />
                    </div>

                    {/* Candidate chips: exactly the 200-grid values inside the
                        0.30–0.80-of-ceiling band (item 3). */}
                    {grid && grid.candidates.length > 0 && (
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="text-[10px] uppercase tracking-wide text-muted">
                          Candidates
                        </span>
                        {grid.candidates.map((v) => (
                          <button
                            key={v}
                            type="button"
                            className={`${CHIP_BUTTON} font-tabular ${
                              value === v ? "border-accent text-accent" : ""
                            }`}
                            onClick={() => setValue(v)}
                          >
                            {v} MHz
                          </button>
                        ))}
                      </div>
                    )}

                    {/* Named specials on their own row, visually distinct
                        from the candidate chips (item 3). */}
                    {bounds.presets.length > 0 && (
                      <div className="flex flex-wrap items-center gap-1.5 border-t border-border pt-2">
                        <span className="text-[10px] uppercase tracking-wide text-muted">
                          Presets
                        </span>
                        {bounds.presets.map((p) => (
                          <button
                            key={p.label}
                            type="button"
                            className={`${CHIP_BASE} cursor-pointer border-dashed border-border bg-surface text-muted transition-colors hover:border-accent hover:text-accent`}
                            onClick={() => setValue(p.value)}
                          >
                            {p.label}
                            {p.value != null ? ` (${p.value})` : ""}
                          </button>
                        ))}
                      </div>
                    )}

                    {result && (
                      <div className="rounded border border-border bg-surface-elevated p-2 text-xs">
                        {/* Requested-vs-applied honesty (item 6): when the
                            driver quantised the request, show BOTH numbers. */}
                        {result.snapped && result.requestedMHz != null ? (
                          <p className="text-warning">
                            You asked for {result.requestedMHz} MHz; the driver applied{" "}
                            {result.appliedMHz ?? "no"} MHz.
                          </p>
                        ) : (
                          <p>
                            Applied {result.appliedMHz == null ? "no cap" : `${result.appliedMHz} MHz`} —{" "}
                            {result.persisted
                              ? "saved to the boot unit (survives reboot)"
                              : "this boot only"}
                          </p>
                        )}
                        {result.warnings.map((w) => (
                          <p key={w} className="mt-1 text-warning">
                            {w}
                          </p>
                        ))}
                      </div>
                    )}
                    {error && <p className="text-danger">{error}</p>}

                    <div className="flex items-center justify-end gap-2 pt-1">
                      <button
                        type="button"
                        disabled={busy}
                        className="rounded border border-border px-3 py-1.5 text-xs text-text hover:border-accent disabled:opacity-40"
                        onClick={() => apply(false)}
                      >
                        Apply (this boot only)
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        className="rounded border border-accent bg-accent/10 px-3 py-1.5 text-xs font-medium text-accent hover:bg-accent/20 disabled:opacity-40"
                        onClick={() => apply(true)}
                      >
                        Save
                      </button>
                    </div>
                    <p className="text-[10px] text-muted">
                      "Apply" lasts until reboot. "Save" rewrites the boot unit so the cap
                      persists. Removing the cap restores the hardware maximum. The driver
                      keeps the final say over the applied value — the panel always reports
                      what it actually set, never what was merely requested.
                    </p>
                  </>
                )}
              </div>
            </div>
          </div>,
          document.body
        )}
    </>
  );
}
