import { useCallback, useEffect, useRef, useState } from "react";
import { fetchGpuClock, fetchSparks, resetFleetGpuClock, setFleetGpuClock } from "../api/client";
import type { FleetGpuClockResult, GpuClockStatus } from "../api/types";

/** Fleet-wide GPU clock options: full capacity first, then 1800–2400 MHz in 100 MHz steps. */
const CAP_PRESETS = [1800, 1900, 2000, 2100, 2200, 2300, 2400] as const;

/**
 * How long one unit's status read may take before the row gives up on it. A
 * Spark behind a dead SSH connection can hang past any patience, and a row
 * stuck on "Reading the fleet…" would never mark a state or offer a way out.
 */
const READ_TIMEOUT_MS = 6000;

/** Resolves null after `ms`, so a stalled read can be raced and counted. */
// ES2022 target: `Promise.withResolvers` (ES2024) is not available here.
const afterNull = (ms: number) => new Promise<null>((resolve) => window.setTimeout(() => resolve(null), ms));

/** What the row hands the dialog: Save owns when a pick is applied. */
export interface FleetGpuClockApi {
  /**
   * True while a pick waits for Save: it differs from what the fleet reports — the
   * cap, or the boot hooks installed against "Keep after reboot" — or
   * the last Save of it did not take (a unit refused, every unit was skipped, the
   * request failed). A later read that happens to match the pick does not settle
   * a failed Save — the cap can land while its boot hook is refused — so it stays
   * pending until a Save of it succeeds or another state is picked.
   */
  pending(): boolean;
  /** Apply the picked state. Resolves false unless at least one unit took it and none refused, so Save can stay open. */
  apply(): Promise<boolean>;
}

interface FleetGpuClockProps {
  /** Filled with the row's actions: Save runs them, a pick on its own changes nothing. */
  apiRef?: { current: FleetGpuClockApi | null };
  /** Told when a pick starts or stops waiting for Save, to gate the Save button. */
  onPendingChange?: (pending: boolean) => void;
  /** Test seam: shorten the per-unit read deadline. */
  readTimeoutMs?: number;
}

/**
 * The cap a unit's installed boot hook keeps across reboots: null with no hook
 * installed, false where what is installed would not keep a cap the way Save
 * writes one — both hooks at once, a service that is not enabled, a job that
 * failed at this boot, or clocks other than the fleet's "0,max".
 */
type BootHook = number | null | false;

/** What the Sparks report right now: one shared cap, a mix, or nothing readable. */
type FleetNow =
  | { kind: "same"; capMHz: number | null; units: number; unreadable: number; boots: BootHook[] }
  | { kind: "mixed"; caps: (number | null)[]; unreadable: number }
  | { kind: "unknown" };

type ReadyStatus = Extract<GpuClockStatus, { supported: true }>;

function bootHook({ service, cron }: ReadyStatus): BootHook {
  if (!service.installed && !cron.installed) return null;
  if (service.installed && cron.installed) return false;
  const clocks = service.installed
    ? service.enabled === "enabled" ? service.clocks : null
    : cron.failed ? null : cron.clocks;
  const m = /^0,(\d+)$/.exec(clocks ?? "");
  return m ? Number(m[1]) : false;
}

/**
 * Fleet-wide GPU clock cap in Settings. One row of states — Full capacity,
 * 1800–2400 MHz — with the one every Spark is on marked; picking another only
 * selects it, and the dialog's **Save** applies it to each unit in turn. Same
 * manager and sudo rules as the per-unit GPU clock cap in Edit unit.
 */
export function FleetGpuClock({
  apiRef,
  onPendingChange,
  readTimeoutMs = READ_TIMEOUT_MS,
}: FleetGpuClockProps) {
  const [now, setNow] = useState<FleetNow | null>(null);
  /** The state the user picked. `undefined` = nothing picked, the fleet's own state stands. */
  const [picked, setPicked] = useState<number | null | undefined>(undefined);
  /**
   * The last Save of `picked` did not take everywhere. Kept apart from comparing
   * the pick with the fleet: a cap can land while its boot hook is refused, and the
   * read after it then matches the pick although the request failed.
   */
  const [unsettled, setUnsettled] = useState(false);
  const [persist, setPersist] = useState(false);
  /** null while nothing could be read: unknown is not the same as refused. */
  const [canPersist, setCanPersist] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; ok: boolean; detail?: string } | null>(null);
  const timer = useRef<number | undefined>(undefined);
  // Once the checkbox is touched, the fleet's own capability stops setting it.
  // The capability default alone never asks for a change: only a pick or a touch does.
  const persistTouched = useRef(false);
  // A failed Save that asked to keep the cap holds the tick as asked: the read
  // after it must not quietly turn the retry into a cap that ends at reboot.
  const persistHeld = useRef(false);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const readUnit = useCallback(async (id: string) => {
    try {
      return await Promise.race([fetchGpuClock(id).catch(() => null), afterNull(readTimeoutMs)]);
    } catch {
      return null;
    }
  }, [readTimeoutMs]);

  /** Only the newest read may write state: a slow pre-apply read must not overwrite a fresh one. */
  const latest = useRef(0);
  useEffect(
    () => () => {
      latest.current += 1;
    },
    [],
  );

  const read = useCallback(async () => {
    const mine = ++latest.current;
    try {
      const res = await Promise.race([fetchSparks(), afterNull(readTimeoutMs)]);
      if (mine !== latest.current) return;
      if (!res) {
        setNow({ kind: "unknown" });
        return;
      }
      // Only the units the cap route acts on are asked: hosts and macOS/Windows
      // units have no clock to cap, so the route skips them before any read.
      const ids = res.sparks
        .filter((spark) => spark.kind === "spark" && spark.platform !== "darwin" && spark.platform !== "windows")
        .map((spark) => spark.id);
      // Each unit gets its own deadline: one unreachable Spark must not hide what
      // the others report, and must not hold the row on "Reading the fleet…".
      const statuses = await Promise.all(ids.map(readUnit));
      // A read that failed or timed out once is retried: a fleet-wide apply leaves
      // the units busy for a moment, and giving up there reads as "no unit knows".
      const retried = await Promise.all(ids.map((id, i) => (statuses[i] === null ? readUnit(id) : null)));
      retried.forEach((status, i) => {
        if (status) statuses[i] = status;
      });
      if (mine !== latest.current) return;

      const ready = statuses.filter((status): status is ReadyStatus => Boolean(status?.supported));
      const caps = ready.map((status) => status.capMHz);
      // Only a read that failed or timed out is unreadable; a unit that answered
      // "no GPU clock here" (`supported: false`) was read, and simply has no cap.
      const unreadable = statuses.filter((status) => !status).length;
      // "Keep after reboot" installs a boot hook: the systemd unit where sudo
      // reaches a root shell, an @reboot cron line where it does not. Offer it
      // only where this fleet can actually keep the cap; with nothing read, leave
      // the answer unknown rather than claiming the fleet refuses.
      const persistOk = ready.length > 0 && ready.every((status) => status.persistKind !== "none");
      setCanPersist(ready.length === 0 ? null : persistOk);
      if (!persistHeld.current && (!persistTouched.current || !persistOk)) setPersist(persistOk);
      if (caps.length === 0) {
        setNow({ kind: "unknown" });
        return;
      }
      const first = caps[0];
      setNow(
        caps.every((cap) => cap === first)
          ? { kind: "same", capMHz: first, units: caps.length, unreadable, boots: ready.map(bootHook) }
          : { kind: "mixed", caps, unreadable },
      );
    } catch {
      if (mine !== latest.current) return;
      setNow({ kind: "unknown" });
    }
  }, [readUnit, readTimeoutMs]);

  useEffect(() => {
    void read();
  }, [read]);

  const shared = now?.kind === "same" ? now.capMHz : undefined;
  // The boot hook every unit should end up with: the picked cap with the tick on,
  // none otherwise — removing the cap keeps nothing, and an unticked cap ends at reboot.
  const wantHook = picked !== undefined && picked !== null && persist ? picked : null;
  // Any pick on a mixed or unreadable fleet is a change: it is asking to unify it.
  // A pick whose last Save failed stays a change even where the fleet now matches it.
  // On a fleet already at the picked cap, a hook that is missing, stale or broken
  // on any unit — or installed where none is asked for — is still a change.
  const pending = picked !== undefined && (
    unsettled || now?.kind !== "same" || now.unreadable > 0 || picked !== shared ||
    now.boots.some((hook) => hook !== wantHook)
  );

  useEffect(() => {
    onPendingChange?.(pending);
  }, [onPendingChange, pending]);

  const apply = useCallback(async () => {
    if (picked === undefined) return true;
    const capMHz = picked;
    setBusy(true);
    setMsg(null);
    try {
      const res = capMHz === null ? await resetFleetGpuClock() : await setFleetGpuClock(capMHz, persist);
      const capped = res.results.filter((r) => r.ok && !("supported" in r)).length;
      const skipped = res.results.filter(
        (r): r is Extract<FleetGpuClockResult, { supported: false }> =>
          "supported" in r && r.supported === false,
      );
      const failed = res.results.filter((r): r is Extract<FleetGpuClockResult, { ok: false }> => !r.ok);
      // One line per distinct reason, not per unit: a fleet-wide refusal is three
      // copies of the same sentence, and repeating it hides the first one.
      const byReason: Record<string, string[]> = {};
      for (const r of failed) byReason[r.error] = [...(byReason[r.error] ?? []), r.id];
      const reasons = Object.keys(byReason).map((error) => `${byReason[error].join(", ")}: ${error}`);
      const detail = [
        ...reasons,
        ...skipped.map((r) => `${r.id}: skipped — ${r.reason}`),
        // The common fleet-wide refusal is a permission the boot service needs and
        // the cap itself does not, so name the way out instead of only the wall.
        ...(reasons.length > 0 && reasons.every((reason) => reason.includes("keeping the cap after reboot"))
          ? ["Untick “Keep after reboot” to cap until the next reboot instead."]
          : []),
      ].join("; ");
      // Which hook took, per unit: one Spark may take the boot service where another
      // falls back to cron, and "kept after reboot" alone hides that.
      // Removing the cap keeps nothing, whatever the tick says.
      const kept = persist && capMHz !== null
        ? res.results.flatMap((r) => (r.ok && "persistKind" in r ? [r.persistKind] : []))
        : [];
      const howKept =
        kept.length === 0
          ? ""
          : kept.every((k) => k === "cron")
            ? " — kept by an @reboot cron job on each unit"
            : kept.some((k) => k === "cron")
              ? " — kept after reboot (boot service or @reboot job, per unit)"
              : " — kept after reboot";
      // A skipped unit is not a failure, but it is not a change either: a fleet where
      // nothing was capped must not read as a success.
      const nothingChanged = capped === 0;
      setMsg({
        ok: failed.length === 0 && !nothingChanged,
        text: nothingChanged
          ? failed.length
            ? `No unit completed the requested change — some changes may have applied${skipped.length ? `, ${skipped.length} skipped` : ""}`
            : `Nothing changed — 0 of ${res.results.length} units ${capMHz === null ? "unlocked" : "capped"}${
                skipped.length ? `, ${skipped.length} skipped` : ""
              }`
          : `${capMHz === null ? "Full capacity" : `Capped at ${capMHz} MHz`} — ${capped} of ${
              res.results.length
            } units${skipped.length ? `, ${skipped.length} skipped` : ""}${howKept}`,
        detail: detail || undefined,
      });
      // The pick is spent once every unit took it (skips are not failures) and at least one did.
      const took = failed.length === 0 && !nothingChanged;
      if (took) {
        setPicked(undefined);
        setUnsettled(false);
        persistHeld.current = false;
      } else {
        // Kept pending, with the tick it was sent with, until a Save of it takes.
        setUnsettled(true);
        if (persist && capMHz !== null) persistHeld.current = true;
      }
      void read();
      return took;
    } catch (err: unknown) {
      setMsg({
        ok: false,
        text: err instanceof Error ? err.message : "GPU clock request failed",
      });
      setUnsettled(true);
      if (persist && capMHz !== null) persistHeld.current = true;
      return false;
    } finally {
      setBusy(false);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setMsg(null), 12_000);
    }
  }, [picked, persist, read]);

  /** A new pick starts over; picking the failed state again keeps its retry. */
  const pick = (state: number | null) => {
    if (state !== picked) {
      setUnsettled(false);
      persistHeld.current = false;
    }
    setPicked(state);
  };

  useEffect(() => {
    if (!apiRef) return;
    apiRef.current = { pending: () => pending, apply };
    return () => {
      apiRef.current = null;
    };
  }, [apiRef, pending, apply]);

  return (
    <div className="set-fleetcap">
      <p className="gpu-clock__now" data-testid="fleet-now">
        {now === null ? (
          "Reading the fleet…"
        ) : now.kind === "unknown" ? (
          "No unit reports its clock right now — reopen Settings to try again."
        ) : now.kind === "mixed" ? (
          `Now: mixed — ${now.caps.map((cap) => (cap === null ? "full capacity" : `${cap} MHz`)).join(", ")}${
            now.unreadable ? `, ${now.unreadable} unreadable` : ""
          }`
        ) : now.capMHz === null ? (
          `Now: full capacity on ${now.units} unit${now.units === 1 ? "" : "s"}${
            now.unreadable ? `, ${now.unreadable} unreadable` : ""
          }`
        ) : (
          `Now: capped at ${now.capMHz} MHz on ${now.units} unit${now.units === 1 ? "" : "s"}${
            now.unreadable ? `, ${now.unreadable} unreadable` : ""
          }`
        )}
      </p>
      <div className="set-fleetcap__presets" role="group" aria-label="GPU clock cap states">
        <button
          type="button"
          className={`btn btn--sm${shared === null ? " is-current" : ""}${
            picked === null ? " is-picked" : ""
          }`}
          onClick={() => pick(null)}
          disabled={busy}
        >
          Full capacity
        </button>
        {CAP_PRESETS.map((mhz) => (
          <button
            key={mhz}
            type="button"
            className={`btn btn--sm${shared === mhz ? " is-current" : ""}${picked === mhz ? " is-picked" : ""}`}
            onClick={() => pick(mhz)}
            disabled={busy}
          >
            {mhz} MHz
          </button>
        ))}
      </div>
      <label className="gpu-clock__check">
        <input
          type="checkbox"
          checked={persist}
          onChange={(e) => {
            persistTouched.current = true;
            persistHeld.current = false;
            setPersist(e.target.checked);
            // A persistence-only change keeps the known shared cap; never invent
            // a frequency when the fleet is mixed or unreadable.
            if (picked === undefined && typeof shared === "number") setPicked(shared);
          }}
          // A tick held from a refused Save can still be cleared, to cap until reboot instead.
          disabled={busy || (canPersist === false && !persist)}
        />
        Keep after reboot — the state you pick also installs a boot hook on each unit
      </label>
      {canPersist === false ? (
        <p className="set-fleetcap__hint">
          Not offered here: these units have no boot hook the cap can use — neither a root shell for the boot service nor
          a running cron service for an @reboot job. The cap applies until the next reboot.
        </p>
      ) : null}
      {pending ? (
        <p className="set-fleetcap__hint">Not applied yet — press Save to change every unit.</p>
      ) : null}
      {busy ? <p className="set-fleetcap__hint">Applying…</p> : null}
      {msg ? (
        <p className={`set-fleetcap__msg${msg.ok ? "" : " is-err"}`} role="status" aria-live="polite">
          {msg.text}
          {msg.detail ? <span className="set-fleetcap__detail">{msg.detail}</span> : null}
        </p>
      ) : null}
    </div>
  );
}
