import type { StorageScanJob } from "../../api/types";
import { RotateIcon } from "../ui/icons";

/** m:ss for a running scan. */
export function formatElapsed(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms)) return "0:00";
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/** Whole minutes (at least 1) until a server time, or null when there is none. */
export function minutesUntil(at: number | null | undefined, now: number): number | null {
  if (at == null || !Number.isFinite(at)) return null;
  return Math.max(1, Math.ceil((at - now) / 60_000));
}

/** A stop was asked for and the Spark could not confirm it: it stays busy until it can. */
export function stopUnconfirmed(job: StorageScanJob): boolean {
  return job.stop?.outcome === "not-terminated" || job.stop?.outcome === "unknown";
}

/**
 * The line under a running scan that says what stopping can and cannot do here, or null. Kept in a reserved
 * line, so the progress card does not jump when it appears.
 */
export function scanStopNote(job: StorageScanJob, now: number): string | null {
  if (job.cancellable === false) {
    const mins = minutesUntil(job.stopsByItselfAt, now);
    return `This scan runs as administrator, so the dashboard cannot stop it. It will stop by itself${mins != null ? ` in ${mins} min at the latest` : ""}.`;
  }
  if (stopUnconfirmed(job)) return job.stop?.message ?? "Could not confirm it stopped — the Spark stays busy until it does.";
  if (job.cancelBestEffort) return "Stopping is best effort here: the dashboard runs in a container and may not see every process of the scan.";
  return null;
}

/** Why the Spark is still busy because of a scan, in words for a disabled control or a banner; null when it is not. */
export function scanHoldNote(job: StorageScanJob | null, now: number): string | null {
  if (!job || !(job.holdsSpark || job.state === "running" || job.state === "stopping")) return null;
  if (stopUnconfirmed(job)) return job.stop?.message ?? "Could not confirm the scan stopped — the Spark stays busy until it does.";
  if (job.state === "stopping") return "The scan on this Spark is being stopped. Other storage work waits until it has.";
  if (job.state === "running") {
    const mins = job.cancellable === false ? minutesUntil(job.stopsByItselfAt, now) : null;
    return `A scan is still running on this Spark${mins != null ? `; it will stop by itself in ${mins} min at the latest` : ""}.`;
  }
  const mins = minutesUntil(job.holdUntil, now);
  return `The dashboard lost contact with this Spark during the last scan, so the Spark stays busy until the dashboard can confirm the scan has ended${mins != null ? ` (in ${mins} min at the latest)` : ""}.`;
}

interface ScanStopProps {
  job: StorageScanJob;
  serverNow: () => number;
  onStop: () => void;
  /** The stop request is on its way to the server. */
  requesting: boolean;
}

/**
 * "Stop scan", or what is true instead: "Stopping…" until the Spark confirms, "Try again" when it could not,
 * and "Stops by itself in N min" for a scan run as administrator (which this account cannot stop).
 */
export function ScanStop({ job, serverNow, onStop, requesting }: ScanStopProps) {
  if (job.cancellable === false) {
    const mins = minutesUntil(job.stopsByItselfAt, serverNow());
    return (
      <span className="st-stop st-stop--self" title="Scans run as administrator cannot be stopped from the dashboard">
        {mins != null ? `Stops by itself in ${mins} min` : "Stops by itself"}
      </span>
    );
  }
  const unconfirmed = stopUnconfirmed(job);
  const stopping = requesting || job.stop?.outcome === "pending";
  return (
    <button
      type="button"
      className="btn btn--sm btn--ghost st-stop"
      onClick={onStop}
      disabled={stopping}
      aria-busy={stopping}
      title={job.cancelBestEffort ? "Stopping is best effort while the dashboard runs in a container" : undefined}
    >
      {stopping ? "Stopping…" : unconfirmed ? "Try stopping again" : "Stop scan"}
    </button>
  );
}

interface ScanProgressProps extends ScanStopProps {
  sparkName: string;
  path: string;
  elapsedMs: number | null;
}

/** Shown while a whole analysis runs. The scan has no honest percentage, so the bar only says "working". */
export function ScanProgress({ sparkName, path, elapsedMs, job, serverNow, onStop, requesting }: ScanProgressProps) {
  const note = scanStopNote(job, serverNow());
  const unconfirmed = stopUnconfirmed(job);
  return (
    <section className="panel st-progress" role="status" aria-live="polite">
      <span className="st-progress__spin" aria-hidden>
        <RotateIcon className="h-5 w-5" />
      </span>
      <h2>
        {job.state === "stopping" ? "Stopping the analysis of " : "Analysing "}
        <span className="mono">{path}</span>
      </h2>
      <p>
        Measuring every folder on {sparkName}. A whole disk usually takes under a minute (longer the first time, while the disk is cold). The scan runs at low
        priority, so models and other work on the Spark keep running normally.
      </p>
      <div className="st-progress__bar" aria-hidden>
        <i />
      </div>
      <div className="st-progress__meta">
        <span className="mono">{formatElapsed(elapsedMs)} elapsed</span>
        <ScanStop job={job} serverNow={serverNow} onStop={onStop} requesting={requesting} />
      </div>
      <p className={`st-progress__note${unconfirmed ? " is-warn" : ""}`} role={unconfirmed ? "alert" : undefined}>
        {note ?? ""}
      </p>
    </section>
  );
}
