import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
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
  const { t } = useTranslation("devices");
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
        setLoadError(err instanceof Error ? err.message : "load");
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
        <span className="field-label">{t("gpu.cap")}</span>
        <p className={`field-hint${loadError ? " is-warn" : ""}`} role="status">
          {loadError === "load" ? t("gpu.loadError") : loadError ?? t("gpu.reading")}
        </p>
      </div>
    );
  }
  if (!status.supported) {
    return (
      <div className="gpu-clock">
        <span className="field-label">{t("gpu.cap")}</span>
        <p className="field-hint">{status.reason || t("gpu.unavailable")}</p>
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
    kind === "cron" ? t("gpu.keptCron") : t("gpu.keptService");

  const run = async (action: () => Promise<string>) => {
    setBusy(true);
    setMessage(null);
    try {
      setMessage({ ok: true, text: await action() });
    } catch (err) {
      setMessage({ ok: false, text: err instanceof Error ? err.message : "refused" });
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
    const how = status.persistKind === "cron" ? t("gpu.cronJob") : t("gpu.systemService");
    if (persist && !confirm(t("gpu.persistConfirm", { how })))
      return;
    void run(async () => {
      const out = await setGpuClock(sparkId, { maxMHz, persist, ...(pwArg ? { sudoPassword: pwArg } : {}) });
      return persist
        ? t("gpu.cappedPersistent", { max: maxMHz, kept: keptText(out.persistKind) })
        : t("gpu.cappedUntilReboot", { max: maxMHz });
    });
  };

  const remove = () => {
    if (!confirm(t("gpu.removeConfirm"))) return;
    void run(async () => {
      await resetGpuClock(sparkId, pwArg);
      return t("gpu.removed");
    });
  };

  const showCommand = async (kind: "apply" | "reset") => {
    setManualError(null);
    setCopied(false);
    try {
      const q = kind === "apply" ? ({ action: "apply", maxMHz, persist } as const) : ({ action: "reset" } as const);
      const { command } = await fetchGpuClockCommand(sparkId, q);
      setManual({
        title: kind === "apply" ? t("gpu.manualApplyTitle", { max: maxMHz, suffix: persist ? t("gpu.manualPersistent") : "" }) : t("gpu.manualRemoveTitle"),
        command,
      });
    } catch (err) {
      setManual(null);
      setManualError(err instanceof Error ? err.message : "commandError");
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
        {t("gpu.cap")}
      </label>
      <p className="gpu-clock__now" data-testid="gpu-clock-now">
        {status.capMHz != null ? (
          <>
            {t("gpu.cappedAt")} <b>{status.capMHz} MHz</b>
            {hwMax != null ? t("gpu.maximum", { max: hwMax }) : ""}
          </>
        ) : (
          <>{t("gpu.noCap")}{hwMax != null ? t("gpu.maximum", { max: hwMax }) : ""}</>
        )}
        {status.service.installed
          ? t("gpu.bootService", { state: status.service.enabled === "enabled" ? t("gpu.enabled") : status.service.enabled || t("gpu.installed"), clocks: status.service.clocks ? ` (${status.service.clocks} MHz)` : "" })
          : status.cron.installed
            ? t("gpu.rebootJob", { clocks: status.cron.clocks ? ` (${status.cron.clocks} MHz)` : "" })
            : t("gpu.notKept")}
      </p>
      {status.cron.installed && status.cron.failed ? (
        <p className="field-hint is-warn" role="alert" data-testid="gpu-clock-boot-failed">
          {t("gpu.bootFailedBefore")} <code>sudo -n nvidia-smi -lgc</code> {t("gpu.bootFailedAfter")}
        </p>
      ) : null}
      <div className="gpu-clock__row">
        <input
          id="gpu-clock-max"
          type="number"
          min={MIN_CAP_MHZ}
          max={hwMax ?? undefined}
          inputMode="numeric"
          placeholder={hwMax != null ? `${MIN_CAP_MHZ}–${hwMax}` : t("gpu.mhz")}
          value={maxInput}
          onChange={(e) => setMaxInput(e.target.value)}
          disabled={busy}
        />
        <span className="gpu-clock__unit">{t("gpu.mhzMax")}</span>
        <button type="button" className="btn btn--sm" onClick={apply} disabled={busy || !valid || !pwOk || (sudoMissing && !secure)}>
          {busy ? t("gpu.working") : t("gpu.apply")}
        </button>
        <button type="button" className="btn btn--sm btn--ghost" onClick={remove} disabled={busy || !pwOk || (sudoMissing && !secure)}>
          {t("gpu.removeLimit")}
        </button>
      </div>
      <label className="gpu-clock__check">
        <input
          type="checkbox"
          checked={persist}
          onChange={(e) => setPersist(e.target.checked)}
          disabled={busy || (cannotPersist && !persist)}
        />
        {t("gpu.keepAfterReboot")} (
        {cannotPersist
          ? t("gpu.notAvailableUnit")
          : status.persistKind === "cron"
            ? t("gpu.cronJob")
            : t("gpu.systemService")}
        )
      </label>
      {needPw && (
        <div>
          <label className="field-label" htmlFor="gpu-clock-sudo-pw">
            {t("gpu.sudoPassword")}
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
            placeholder={t("gpu.passwordPlaceholder")}
          />
          <p className="field-hint">
            {t("gpu.passwordHelp")}
          </p>
        </div>
      )}
      {sudoMissing && !secure && (
        <p className="field-hint is-warn">
          {t("gpu.insecureBefore")} <code>nvidia-smi -lgc</code> {t("gpu.insecureBetween")} <code>-rgc</code> {t("gpu.insecureAfter")}
        </p>
      )}
      {!sudoMissing && (
        <p className="field-hint">
          {t("gpu.runsBefore")} <code>nvidia-smi -lgc 0,MAX</code>{status.sudo === "root" ? t("gpu.asRoot") : t("gpu.throughSudo")}{t("gpu.runsAfter")}
        </p>
      )}
      {cannotPersist ? (
        <p className="field-hint is-warn">
          {t("gpu.cannotPersist")}
        </p>
      ) : null}
      {maxInput.trim() !== "" && !valid && (
        <p className="field-hint is-warn">
          {t("gpu.range", { min: MIN_CAP_MHZ, max: hwMax != null ? `–${hwMax}` : "" })}
        </p>
      )}
      <details className="gpu-clock__manual" open={(sudoMissing && !secure) || manual != null}>
        <summary>{t("gpu.manual")}</summary>
        <p className="field-hint">
          {t("gpu.manualBefore")} <code>sudo</code> {t("gpu.manualAfter")}
        </p>
        <div className="gpu-clock__row">
          <button type="button" className="btn btn--sm" onClick={() => void showCommand("apply")} disabled={!valid}>
            {t("gpu.showApply")}
          </button>
          <button type="button" className="btn btn--sm btn--ghost" onClick={() => void showCommand("reset")}>
            {t("gpu.showRemove")}
          </button>
        </div>
        {manualError && <p className="field-hint is-warn" role="status">{manualError === "commandError" ? t("gpu.commandError") : manualError}</p>}
        {manual && (
          <>
            <p className="gpu-clock__now">{manual.title}</p>
            <textarea className="gpu-clock__command" readOnly rows={8} value={manual.command} aria-label={t("gpu.commandAria")} onFocus={(e) => e.currentTarget.select()} />
            <div className="gpu-clock__row">
              <button type="button" className="btn btn--sm" onClick={() => void copyCommand()}>
                {copied ? t("gpu.copied") : t("gpu.copy")}
              </button>
            </div>
          </>
        )}
      </details>
      {loadError && <p className="field-hint is-warn" role="status">{loadError === "load" ? t("gpu.loadError") : `${t("gpu.refreshError")}: ${loadError}`}</p>}
      {message && (
        <p className={`field-hint ${message.ok ? "is-ok" : "is-warn"}`} role="status">
          {message.text === "refused" ? t("gpu.refused") : message.text}
        </p>
      )}
    </div>
  );
}
