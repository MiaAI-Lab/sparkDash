import { useCallback, useEffect, useRef, useState } from "react";
import { fetchGpuPower, setGpuPower } from "../api/client";
import type { GpuPowerCard, GpuPowerStatus } from "../api/types";
import { shortGpuName } from "../shared/gpuName";

/** Whole watts a card accepts: nvidia-smi can report a fractional range. */
const lowestW = (c: GpuPowerCard) => Math.ceil(c.minW ?? 0);
const highestW = (c: GpuPowerCard) => Math.floor(c.maxW ?? 0);
const shownW = (w: number | null) => (w == null ? "—" : `${Math.round(w)} W`);
const cardName = (c: GpuPowerCard) => `GPU ${c.index ?? "?"}`;

/**
 * Per-card GPU power limit for one dedicated GPU host (Edit unit). Acts immediately on the host
 * with the saved connection settings: it is not part of the Save button.
 */
export function GpuPowerSection({ sparkId }: { sparkId: string }) {
  const [status, setStatus] = useState<GpuPowerStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  /** Watts typed for each card, by uuid. */
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [persist, setPersist] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  /** Typed sudo password: kept in this component's state only, sent with one request, then cleared. */
  const [sudoPw, setSudoPw] = useState("");
  /** Only the newest request may write state: a slow answer for an older unit must not win. */
  const latest = useRef(0);
  const sparkRef = useRef(sparkId);
  sparkRef.current = sparkId;

  const load = useCallback(
    async () => {
      const mine = ++latest.current;
      try {
        const s = await fetchGpuPower(sparkId);
        if (mine !== latest.current) return;
        setStatus(s);
        setLoadError(null);
        if (s.supported) {
          setInputs(Object.fromEntries(s.cards.map((c) => [c.uuid, c.limitW != null ? String(Math.round(c.limitW)) : ""])));
          setPersist(s.service.installed);
        }
      } catch (err) {
        if (mine !== latest.current) return;
        // Keep what is on screen after a failed refresh; the message says what went wrong.
        setLoadError(err instanceof Error ? err.message : "Could not read the GPU power limits");
      }
    },
    [sparkId]
  );

  useEffect(() => {
    setStatus(null);
    setLoadError(null);
    setMessage(null);
    setInputs({});
    setPersist(false);
    setSudoPw("");
    setBusy(false);
    void load();
    return () => {
      latest.current += 1;
    };
  }, [load]);

  if (!status) {
    return (
      <div className="gpu-clock">
        <span className="field-label">GPU power limit</span>
        <p className={`field-hint${loadError ? " is-warn" : ""}`} role="status">
          {loadError ?? "Reading the host…"}
        </p>
      </div>
    );
  }
  if (!status.supported) {
    return (
      <div className="gpu-clock">
        <span className="field-label">GPU power limit</span>
        <p className="field-hint">{status.reason || "Not available on this host."}</p>
      </div>
    );
  }

  const rows = status.cards.filter((c) => c.adjustable);
  const typed = (c: GpuPowerCard) => (inputs[c.uuid] ?? "").trim();
  const valid = (c: GpuPowerCard) => /^\d+$/.test(typed(c)) && Number(typed(c)) >= lowestW(c) && Number(typed(c)) <= highestW(c);
  const changed = rows.filter((c) => typed(c) !== String(Math.round(c.limitW ?? 0)));
  const installed = status.service.installed;
  /** The boot service would set something other than what the cards run at now. */
  const bootStale = installed && rows.some((c) => c.bootW == null || Math.round(c.bootW) !== Math.round(c.limitW ?? 0));
  const dirty = changed.length > 0 || persist !== installed || (persist && bootStale);
  const sudoMissing = status.sudo === "no";
  /** A password typed here crosses the network: only over https or from the machine itself. */
  const secure =
    (typeof window === "undefined" || window.isSecureContext !== false || status.plainPasswordAllowed === true) && status.passwordAllowed !== false;
  const needPw = sudoMissing && secure;
  const pwOk = !needPw || sudoPw.length > 0;
  const manualCommand = (changed.length > 0 ? changed : rows)
    .filter(valid)
    .map((c) => `sudo nvidia-smi -i ${c.uuid} -pl ${typed(c)}`)
    .join("\n");

  const apply = async () => {
    if (persist && !installed && !confirm("Install a system service on this host that re-applies the limits at every boot? It runs as root through sudo.")) return;
    const set = changed.map((c) => `${cardName(c)} ${typed(c)} W`).join(", ");
    setBusy(true);
    setMessage(null);
    try {
      await setGpuPower(sparkId, {
        limits: changed.map((c) => ({ uuid: c.uuid, watts: Number(typed(c)) })),
        persist,
        ...(needPw ? { sudoPassword: sudoPw } : {}),
      });
      const text = set
        ? `${set}, ${persist ? "kept after reboot" : "until the next reboot"}.`
        : persist ? "Limits kept after reboot." : "Boot service removed.";
      setMessage({ ok: true, text });
    } catch (err) {
      setMessage({ ok: false, text: err instanceof Error ? err.message : "The host refused the change" });
    } finally {
      // A slow answer for the unit you just left must not wipe what you type for this one.
      if (sparkRef.current === sparkId) {
        setBusy(false);
        setSudoPw("");
        await load();
      }
    }
  };

  const fillDefaults = () => {
    setInputs((prev) => {
      const next = { ...prev };
      for (const c of rows) if (c.defaultW != null) next[c.uuid] = String(Math.round(c.defaultW));
      return next;
    });
  };

  return (
    <div className="gpu-clock">
      <span className="field-label">GPU power limit</span>
      {status.cards.map((c) => (
        <div className="gpu-power__card" key={c.uuid}>
          <label className="gpu-clock__now" htmlFor={`gpu-power-${c.uuid}`}>
            <b>{cardName(c)}</b>
            {shortGpuName(c.name) ? ` · ${shortGpuName(c.name)}` : ""} · now {shownW(c.limitW)}
            {c.enforcedW != null && c.limitW != null && Math.round(c.enforcedW) !== Math.round(c.limitW) ? ` (enforced ${shownW(c.enforcedW)})` : ""}
          </label>
          {c.adjustable ? (
            <div className="gpu-clock__row">
              <input
                id={`gpu-power-${c.uuid}`}
                type="number"
                min={lowestW(c)}
                max={highestW(c)}
                inputMode="numeric"
                value={inputs[c.uuid] ?? ""}
                onChange={(e) => setInputs((prev) => ({ ...prev, [c.uuid]: e.target.value }))}
                disabled={busy}
              />
              <span className="gpu-clock__unit">
                W ({lowestW(c)}–{highestW(c)}, default {shownW(c.defaultW)}
                {installed && c.bootW != null && Math.round(c.bootW) !== Math.round(c.limitW ?? 0) ? `, boot service sets ${shownW(c.bootW)}` : ""})
              </span>
            </div>
          ) : (
            <p className="field-hint">This card does not report a power limit range, so it cannot be set here.</p>
          )}
          {c.adjustable && typed(c) !== "" && !valid(c) && (
            <p className="field-hint is-warn">
              Enter a whole number from {lowestW(c)} to {highestW(c)}.
            </p>
          )}
        </div>
      ))}
      <label className="gpu-clock__check">
        <input type="checkbox" checked={persist} onChange={(e) => setPersist(e.target.checked)} disabled={busy} />
        Keep after reboot (installs a system service)
      </label>
      {status.service.active === "failed" && (
        <p className="field-hint is-warn">The boot service failed the last time it ran. Press Apply with this ticked to write it again.</p>
      )}
      {status.otherServices.length > 0 && (
        <p className="field-hint is-warn">
          {status.otherServices.join(", ")} also {status.otherServices.length > 1 ? "set" : "sets"} a power limit at boot.{" "}
          {persist
            ? "The service kept here runs after it, so these limits are the ones that stay."
            : "Without Keep after reboot, the cards go back to its value at the next reboot."}
        </p>
      )}
      {needPw && (
        <div>
          <label className="field-label" htmlFor="gpu-power-sudo-pw">
            sudo password for this host
          </label>
          <input
            id="gpu-power-sudo-pw"
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
            This host has no passwordless sudo. The password is sent once, over this connection, to run the change, then
            discarded: it is never stored or logged.
          </p>
        </div>
      )}
      {sudoMissing && !secure && (
        <>
          <p className="field-hint is-warn">
            This connection is not on https or the machine itself, so a sudo password is not typed here (it would cross the
            network in the clear). Open the dashboard over https, turn on Settings → Allow sudo password over plain http, or
            run this on the host (it does not install the boot service):
          </p>
          <textarea
            className="gpu-clock__command"
            readOnly
            rows={Math.max(2, rows.length)}
            value={manualCommand}
            aria-label="Command to run on the host"
            onFocus={(e) => e.currentTarget.select()}
          />
        </>
      )}
      <div className="gpu-clock__row">
        <button
          type="button"
          className="btn btn--sm"
          onClick={() => void apply()}
          disabled={busy || !dirty || !changed.every(valid) || !pwOk || (sudoMissing && !secure)}
        >
          {busy ? "Working…" : "Apply"}
        </button>
        <button type="button" className="btn btn--sm btn--ghost" onClick={fillDefaults} disabled={busy}>
          Fill in defaults
        </button>
      </div>
      {!sudoMissing && (
        <p className="field-hint">
          Runs <code>nvidia-smi -i CARD -pl WATTS</code>{status.sudo === "root" ? " as root on this machine" : " through sudo"}, using the
          saved connection settings. Applies at once; it is not part of Save.
        </p>
      )}
      {loadError && <p className="field-hint is-warn" role="status">Could not refresh: {loadError}</p>}
      {message && (
        <p className={`field-hint ${message.ok ? "is-ok" : "is-warn"}`} role="status">
          {message.text}
        </p>
      )}
    </div>
  );
}
