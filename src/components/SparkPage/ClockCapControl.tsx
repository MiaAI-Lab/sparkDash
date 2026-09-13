import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { getClockCapBounds, setClockCap } from "../../api/client";
import type { ClockCapBoundsResponse, ClockCapDomain } from "../../api/types";
import { useModalPresence } from "../../hooks/useModalPresence";
import { useFocusTrap } from "../../hooks/useFocusTrap";
import { InfoIcon } from "../ui/icons";

interface ClockCapControlProps {
  sparkId: string;
  domain: string;
  /** Current cap in MHz, or null when uncapped / unknown. */
  currentMHz: number | null;
  /** Display string for the closed (button) state, e.g. "2200" or "2200 / 3003". */
  display: string;
  /** False → plain text (control disabled with the server-provided reason). */
  enabled?: boolean;
  disabledReason?: string;
  className?: string;
}

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
 * Clickable "Clock Cap" value shared by the GPU and CPU panels. Opens a dialog
 * offering a slider + number input bounded by the discovered hardware range,
 * named presets, an "Apply (this boot only)" button and a persisted "Save".
 * No password / sudo prompt exists anywhere by design — provisioning is a
 * one-time helper install (see README "Clock control").
 */
export function ClockCapControl({
  sparkId,
  domain,
  currentMHz,
  display,
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
  const [result, setResult] = useState<{ warnings: string[]; persisted: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
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
      setResult({ warnings: res.warnings ?? [], persisted: res.persisted });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (!enabled) {
    return (
      <span
        className={`inline-flex items-center gap-1 text-muted ${className ?? ""}`}
        title={disabledReason || "Clock control is disabled (enable it in Edit Spark)"}
      >
        <span className="font-tabular text-sm text-muted">{display}</span>
        <InfoIcon className="h-3.5 w-3.5" />
      </span>
    );
  }

  return (
    <>
      <button
        type="button"
        className={`cursor-pointer font-tabular text-sm text-text underline decoration-dotted decoration-border underline-offset-2 hover:text-accent ${className ?? ""}`}
        title="Click to change the clock cap"
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
      >
        {display}
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
              className="modal-sheet max-w-md"
              role="dialog"
              aria-modal="true"
              aria-labelledby={titleId}
            >
              <div className="modal-sheet__header flex items-center gap-2" id={titleId}>
                <span>Clock cap — {bounds?.label ?? domain}</span>
              </div>

              <div className="space-y-3 text-sm">
                {!loaded && <p className="text-muted">Reading hardware bounds…</p>}
                {loadError && <p className="text-danger">{loadError}</p>}

                {loaded && bounds && (
                  <>
                    <p className="text-muted">
                      Hardware range: {rangeInfo}. Current: {currentMHz != null ? `${currentMHz} MHz` : "no cap value reported"}
                      {bounds.unitPath ? ` · boot unit ${bounds.unitPath}` : ""}
                    </p>
                    {boundsWarnings.map((w) => (
                      <p key={w} className="text-warning">
                        {w}
                      </p>
                    ))}

                    <div className="flex items-center gap-3">
                      <input
                        type="range"
                        min={bounds.hardMinMHz}
                        max={bounds.hardMaxMHz}
                        step={bounds.stepMHz}
                        value={value ?? bounds.hardMaxMHz}
                        onChange={(e) => setValue(clamp(Number(e.target.value)))}
                        aria-label="Clock cap in MHz (slider)"
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

                    <div className="flex flex-wrap gap-2">
                      {bounds.presets.map((p) => (
                        <button
                          key={p.label}
                          type="button"
                          className="rounded border border-border bg-surface-elevated px-2 py-1 text-xs text-text hover:border-accent"
                          onClick={() => setValue(p.value)}
                        >
                          {p.label}
                          {p.value != null ? ` (${p.value})` : ""}
                        </button>
                      ))}
                    </div>

                    {result && (
                      <div className="rounded border border-border bg-surface-elevated p-2 text-xs">
                        <p>
                          Applied: {result.persisted ? "saved to the boot unit (survives reboot)" : "this boot only"}
                        </p>
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
                      persists. Removing the cap restores the hardware maximum.
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
