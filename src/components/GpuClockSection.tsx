import { useCallback, useEffect, useRef, useState } from "react";
import { fetchGpuClock, fetchGpuClockCommand, resetGpuClock, setGpuClock } from "../api/client";
import type { GpuClockStatus } from "../api/types";

const MIN_CAP_MHZ = 300;

type Ready = Extract<GpuClockStatus, { supported: true }>;

/** Highest clock a boot hook applies, e.g. "0,2200" -> 2200. */
function bootMax(status: Ready): number | null {
  const m = /^\d+,(\d+)$/.exec(status.service.clocks ?? status.cron.clocks ?? "");
  return m ? Number(m[1]) : null;
}

/**
 * GPU clock cap for one Spark (Edit unit). Acts immediately on the unit with the
 * saved connection settings: it is not part of the Save button.
 */
export function GpuClockSection({ sparkId }: { sparkId: string }) {
  const [status, setStatus] = useState<GpuClockStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [maxInput, setMaxInput] = useState("");
  const [persist, setPersist] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  /** Command for running the change by hand on the unit (plain sudo, asks for the password). */
  const [manual, setManual] = useState<{ title: string; command: string } | null>(null);
  const [manualError, setManualError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  /** Typed sudo password: kept in this component's state only, sent with one request, then cleared. */
  const [sudoPw, setSudoPw] = useState("");
  /** Only the newest request may write state: a slow answer for an older unit must not win. */
  const latest = useRef(0);
  const sparkRef = useRef(sparkId);
  sparkRef.current = sparkId;

  const syncInputs = (s: GpuClockStatus) => {
    if (!s.supported) return;
    const cap = s.capMHz ?? bootMax(s);
    setMaxInput(cap != null ? String(cap) : "");
    setPersist(s.service.installed || s.cron.installed);
  };

  const load = useCallback(
    async (opts: { sync: boolean }) => {
      const mine = ++latest.current;
      try {
        const s = await fetchGpuClock(sparkId);
        if (mine !== latest.current) return;
        setStatus(s);
        setLoadError(null);
        if (opts.sync) syncInputs(s);
      } catch (err) {
        if (mine !== latest.current) return;
        // Keep what is on screen after a failed refresh; the message says what went wrong.
        setLoadError(err instanceof Error ? err.message : "Could not read the GPU clock cap");
      }
    },
    [sparkId]
  );

  useEffect(() => {
    setStatus(null);
    setLoadError(null);
    setMessage(null);
    setMaxInput("");
    setPersist(false);
    setManual(null);
    setManualError(null);
    setSudoPw("");
    setBusy(false);
    void load({ sync: true });
    return () => {
      latest.current += 1;
    };
  }, [load]);

  if (!status) {
    return (
      <div className="gpu-clock">
        <span className="field-label">GPU clock cap</span>
        <p className={`field-hint${loadError ? " is-warn" : ""}`} role="status">
          {loadError ?? "Reading the unit…"}
        </p>
      </div>
    );
  }
  if (!status.supported) {
    return (
      <div className="gpu-clock">
        <span className="field-label">GPU clock cap</span>
        <p className="field-hint">{status.reason || "Not available on this unit."}</p>
      </div>
    );
  }

  const hwMax = status.hwMaxMHz;
  const maxMHz = Number(maxInput);
  const valid =
    maxInput.trim() !== "" &&
    Number.isInteger(maxMHz) &&
    maxMHz >= MIN_CAP_MHZ &&
    (hwMax == null || maxMHz <= hwMax);
  const sudoMissing = status.sudo === "no";
  /** A password typed here crosses the network: only over https or from the machine itself. */
  const secure =
    (typeof window === "undefined" || window.isSecureContext !== false) && status.passwordAllowed !== false;
  const needPw = sudoMissing && secure;
  const pwOk = !needPw || sudoPw.length > 0;
  const pwArg = needPw ? sudoPw : undefined;
  /**
   * No boot hook is reachable here at all: the checkbox says so instead of refusing on Apply.
   * Without passwordless sudo the status cannot probe for one, so a typed password decides it on the unit.
   */
  const cannotPersist = !sudoMissing && status.persistKind === "none";

  /** How this unit keeps the cap, as the response reported it. */
  const keptText = (kind: string) =>
    kind === "cron" ? "kept after reboot by an @reboot cron job" : "kept after reboot by a boot service";

  const run = async (action: () => Promise<string>) => {
    setBusy(true);
    setMessage(null);
    try {
      setMessage({ ok: true, text: await action() });
    } catch (err) {
      setMessage({ ok: false, text: err instanceof Error ? err.message : "The unit refused the change" });
    } finally {
      // A slow answer for the unit you just left must not wipe what you type for this one.
      if (sparkRef.current === sparkId) {
        setBusy(false);
        setSudoPw("");
        await load({ sync: true });
      }
    }
  };

  const apply = () => {
    const how = status.persistKind === "cron" ? "an @reboot cron job" : "a system service";
    if (persist && !confirm(`Keep the cap after reboot with ${how}? It re-applies the cap at every boot on this unit.`))
      return;
    void run(async () => {
      const out = await setGpuClock(sparkId, { maxMHz, persist, ...(pwArg ? { sudoPassword: pwArg } : {}) });
      return persist
        ? `Capped at ${maxMHz} MHz and ${keptText(out.persistKind)}.`
        : `Capped at ${maxMHz} MHz until the next reboot.`;
    });
  };

  const remove = () => {
    if (!confirm("Remove the GPU clock cap and its boot hook from this unit?")) return;
    void run(async () => {
      await resetGpuClock(sparkId, pwArg);
      return "Cap removed.";
    });
  };

  const showCommand = async (kind: "apply" | "reset") => {
    setManualError(null);
    setCopied(false);
    try {
      const q = kind === "apply" ? ({ action: "apply", maxMHz, persist } as const) : ({ action: "reset" } as const);
      const { command } = await fetchGpuClockCommand(sparkId, q);
      setManual({
        title: kind === "apply" ? `Cap at ${maxMHz} MHz${persist ? " and keep after reboot" : ""}` : "Remove the cap",
        command,
      });
    } catch (err) {
      setManual(null);
      setManualError(err instanceof Error ? err.message : "Could not build the command");
    }
  };

  const copyCommand = async () => {
    if (!manual) return;
    try {
      await navigator.clipboard.writeText(manual.command);
      setCopied(true);
    } catch {
      // Plain-http dashboards have no clipboard API: the text box below is selectable.
      setCopied(false);
    }
  };

  return (
    <div className="gpu-clock">
      <label className="field-label" htmlFor="gpu-clock-max">
        GPU clock cap
      </label>
      <p className="gpu-clock__now" data-testid="gpu-clock-now">
        {status.capMHz != null ? (
          <>
            Capped at <b>{status.capMHz} MHz</b>
            {hwMax != null ? ` (GPU maximum ${hwMax} MHz)` : ""}
          </>
        ) : (
          <>No cap in effect{hwMax != null ? ` (GPU maximum ${hwMax} MHz)` : ""}</>
        )}
        {status.service.installed
          ? ` · boot service ${status.service.enabled === "enabled" ? "enabled" : status.service.enabled || "installed"}${
              status.service.clocks ? ` (${status.service.clocks} MHz)` : ""
            }`
          : status.cron.installed
            ? ` · @reboot job${status.cron.clocks ? ` (${status.cron.clocks} MHz)` : ""}`
            : " · not kept after reboot"}
      </p>
      <div className="gpu-clock__row">
        <input
          id="gpu-clock-max"
          type="number"
          min={MIN_CAP_MHZ}
          max={hwMax ?? undefined}
          inputMode="numeric"
          placeholder={hwMax != null ? `${MIN_CAP_MHZ}–${hwMax}` : "MHz"}
          value={maxInput}
          onChange={(e) => setMaxInput(e.target.value)}
          disabled={busy}
        />
        <span className="gpu-clock__unit">MHz max</span>
        <button type="button" className="btn btn--sm" onClick={apply} disabled={busy || !valid || !pwOk || (sudoMissing && !secure)}>
          {busy ? "Working…" : "Apply"}
        </button>
        <button type="button" className="btn btn--sm btn--ghost" onClick={remove} disabled={busy || !pwOk || (sudoMissing && !secure)}>
          Remove limit
        </button>
      </div>
      <label className="gpu-clock__check">
        <input
          type="checkbox"
          checked={persist}
          onChange={(e) => setPersist(e.target.checked)}
          disabled={busy || cannotPersist}
        />
        Keep after reboot (
        {cannotPersist
          ? "not available on this unit"
          : status.persistKind === "cron"
            ? "an @reboot cron job"
            : "a system service"}
        )
      </label>
      {needPw && (
        <div>
          <label className="field-label" htmlFor="gpu-clock-sudo-pw">
            sudo password for this unit
          </label>
          <input
            id="gpu-clock-sudo-pw"
            type="password"
            autoComplete="new-password"
            data-1p-ignore
            data-lpignore="true"
            value={sudoPw}
            onChange={(e) => setSudoPw(e.target.value)}
            disabled={busy}
            placeholder="used for this change only"
          />
          <p className="field-hint">
            This unit has no passwordless sudo. The password is sent once, over this connection, to run the change, then
            discarded: it is never stored or logged.
          </p>
        </div>
      )}
      {sudoMissing && !secure && (
        <p className="field-hint is-warn">
          This connection is not on https or the machine itself, so a sudo password is not typed here (it would cross the
          network in the clear). Open the dashboard over https or from the Spark itself, run the change on the Spark with
          the command below, or give that user passwordless sudo for <code>nvidia-smi -lgc</code> and <code>-rgc</code>{" "}
          — a rule for those two commands is enough.
        </p>
      )}
      {!sudoMissing && (
        <p className="field-hint">
          Runs <code>nvidia-smi -lgc 0,MAX</code>{status.sudo === "root" ? " as root on this machine" : " through sudo"}, using the
          saved connection settings. Applies at once; it is not part of Save.
        </p>
      )}
      {cannotPersist ? (
        <p className="field-hint is-warn">
          Keeping the cap after reboot needs either passwordless sudo for a root shell (the boot service) or a running
          cron service (an @reboot job), and this unit offers neither. The cap applies until the next reboot.
        </p>
      ) : null}
      {maxInput.trim() !== "" && !valid && (
        <p className="field-hint is-warn">
          Enter a whole number from {MIN_CAP_MHZ}{hwMax != null ? ` to ${hwMax}` : ""}.
        </p>
      )}
      <details className="gpu-clock__manual" open={(sudoMissing && !secure) || manual != null}>
        <summary>Run it on the Spark yourself</summary>
        <p className="field-hint">
          Paste the command into a terminal on the Spark. It uses plain <code>sudo</code>, so it asks for your password
          there. It is the same steps the Apply and Remove buttons run.
        </p>
        <div className="gpu-clock__row">
          <button type="button" className="btn btn--sm" onClick={() => void showCommand("apply")} disabled={!valid}>
            Show command: apply
          </button>
          <button type="button" className="btn btn--sm btn--ghost" onClick={() => void showCommand("reset")}>
            Show command: remove
          </button>
        </div>
        {manualError && <p className="field-hint is-warn" role="status">{manualError}</p>}
        {manual && (
          <>
            <p className="gpu-clock__now">{manual.title}</p>
            <textarea className="gpu-clock__command" readOnly rows={8} value={manual.command} aria-label="Command to run on the Spark" onFocus={(e) => e.currentTarget.select()} />
            <div className="gpu-clock__row">
              <button type="button" className="btn btn--sm" onClick={() => void copyCommand()}>
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
          </>
        )}
      </details>
      {loadError && <p className="field-hint is-warn" role="status">Could not refresh: {loadError}</p>}
      {message && (
        <p className={`field-hint ${message.ok ? "is-ok" : "is-warn"}`} role="status">
          {message.text}
        </p>
      )}
    </div>
  );
}
