import { useEffect, useRef, useState } from "react";
import { acknowledgeElevatedDelete, ApiError } from "../../api/client";
import type { StorageBulkDeleteJob, StorageElevatedDeleteAck, StorageElevation } from "../../api/types";
import { formatBytes } from "../../shared/formatBytes";
import { AlertTriangleIcon, CopyIcon, FileIcon, FolderIcon, LinkIcon, TrashIcon } from "../ui/icons";
import { AdminDeleteAckField } from "./AdminDeleteAck";
import { AdminFields } from "./AdminFields";
import { Banner } from "./Banner";
import { DeleteAdviceBlock } from "./DeleteAdvice";
import { confirmMatches, confirmPhrase, type SelectionSummary } from "./selection";
import { StorageDialog } from "./StorageDialog";
import { baseName, freesOf, shellQuote } from "./storageTree";
import type { AdminAccess } from "./useAdminAccess";
import { useDeleteAdvice } from "./useDeleteAdvice";

/** Items listed by name in the dialog; the rest are counted. */
export const BULK_LISTED = 6;

/** Answers that stop a bulk delete and that the person can fix right in the dialog (when nothing was deleted yet). */
const FIXABLE_STOPS = new Set(["bad-password", "password-locked", "no-ack", "no-sudo"]);

/**
 * A finished bulk delete the dialog keeps open for, because nothing was deleted and what stopped it can be fixed
 * there: a password, the administrator acknowledgement, or (as the account itself) a refusal that administrator
 * rights can get past. Anything else closes the dialog and the page reports the result.
 */
export function bulkFixable(job: StorageBulkDeleteJob): boolean {
  if (job.state !== "done" || job.deleted.length > 0) return false;
  if (job.stopped && FIXABLE_STOPS.has(job.stopped.code)) return true;
  return !job.elevated && job.failed.length > 0 && job.skipped.length === 0 && job.failed.every((f) => f.code === "permission");
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const notTried = (reason: string) => reason.replace(/^Not tried:\s*/, "").replace(/\.$/, "");

interface BulkDeleteReportProps {
  job: StorageBulkDeleteJob;
  /** About what the deleted items freed (from the analysis), or null when not known. */
  freed: number | null;
  /** The part of the deleted items that is hard-linked elsewhere and stays on disk. */
  shared: number;
  onDismiss: () => void;
}

/**
 * How a bulk delete ended, in plain counts: what was deleted and roughly what that freed, and what was not, with
 * each reason in a disclosure. Items the Spark kept aside are named as being under "Needs attention".
 */
export function BulkDeleteReport({ job, freed, shared, onDismiss }: BulkDeleteReportProps) {
  const n = job.deleted.length;
  const problems = job.failed.length + job.skipped.length;
  const kept = job.failed.filter((f) => f.quarantineId).length;
  const tone = n === job.total && problems === 0 ? "ok" : n === 0 ? "error" : "warn";
  const parts: string[] = [n === job.total ? `Deleted ${plural(n, "item")}.` : n === 0 ? "Nothing was deleted." : `Deleted ${n} of ${job.total}.`];
  if (n > 0 && freed != null) {
    parts.push(`About ${formatBytes(freed)} freed.`);
    if (shared > 0) parts.push(`${formatBytes(shared)} of it is hard-linked elsewhere and stays on disk until its other links are deleted.`);
  }
  if (job.failed.length === 1) parts.push(`1 could not be deleted: ${baseName(job.failed[0].path)} — ${job.failed[0].message.replace(/\.$/, "")}.`);
  else if (job.failed.length > 1) parts.push(`${job.failed.length} could not be deleted.`);
  if (job.skipped.length > 0) parts.push(`${job.skipped.length} ${job.skipped.length === 1 ? "was" : "were"} not tried: ${notTried(job.skipped[0].reason)}.`);
  if (kept > 0) parts.push(`${kept} ${kept === 1 ? "is" : "are"} kept under Needs attention.`);
  if (job.covered.length > 0) parts.push(`${plural(job.covered.length, "item")} inside selected folders ${job.covered.length === 1 ? "was" : "were"} included.`);
  if (problems > 0) parts.push(`${problems === 1 ? "It stays" : "They stay"} selected, so you can try again.`);
  return (
    <Banner tone={tone} onDismiss={onDismiss}>
      <span className="st-bulk-report__text">{parts.join(" ")}</span>
      {problems > 0 ? (
        <details className="st-bulk-report">
          <summary>
            Show what was not deleted ({problems})
          </summary>
          <ul>
            {job.failed.map((f) => (
              <li key={f.path}>
                <b>{baseName(f.path)}</b> <span className="st-bulk-report__path mono">{f.path}</span>
                <span className="st-bulk-report__why">
                  {f.message}
                  {f.partial ? " Some of it may already be gone." : ""}
                  {f.quarantineId ? " It is kept under Needs attention." : ""}
                </span>
                {f.command ? <code className="st-bulk-report__cmd mono st-selectable">{f.command}</code> : null}
              </li>
            ))}
            {job.skipped.map((sk) => (
              <li key={sk.path}>
                <b>{baseName(sk.path)}</b> <span className="st-bulk-report__path mono">{sk.path}</span>
                <span className="st-bulk-report__why">{sk.reason}</span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </Banner>
  );
}

interface Problem {
  text: string;
  /** The password field is what to fix. */
  password?: boolean;
}

interface BulkDeleteDialogProps {
  sparkId: string;
  sparkName: string;
  /** What to delete (the outer items, biggest first) and its totals; null when closed. */
  selection: SelectionSummary | null;
  access: AdminAccess;
  /** Start with administrator rights ticked, e.g. because the scan needed them. */
  preferAdmin: boolean;
  ack?: StorageElevatedDeleteAck | null;
  account?: string | null;
  onAckChanged?: () => void;
  /** The run on the Spark once started from here: progress while it runs, and how it ended. */
  job: StorageBulkDeleteJob | null;
  /** Start the run; resolves with it once the dashboard has accepted it (its progress then follows in `job`). */
  onStart: (paths: string[], elevation: StorageElevation) => Promise<StorageBulkDeleteJob>;
  onClose: () => void;
}

/**
 * Confirm and run a permanent delete of several items. The same shell and rules as the single delete dialog: a
 * fixed width, the error right under the items, the administrator section laid out but hidden until ticked, and a
 * typed phrase (`delete N items`) before anything runs. While the Spark works through the items the dialog shows
 * "Deleting 3 of 12…" in the place of the phrase; when it ends the page reports what happened, unless nothing was
 * deleted and the reason can be fixed here (a password, the acknowledgement, administrator rights). The delete check
 * (DeleteAdviceBlock) sums up what was found about the items and may ask for a tick or a typed phrase on top.
 */
export function BulkDeleteDialog({ sparkId, sparkName, selection, access, preferAdmin, ack = null, account = null, onAckChanged, job, onStart, onClose }: BulkDeleteDialogProps) {
  const [typed, setTyped] = useState("");
  const [asAdmin, setAsAdmin] = useState(false);
  const [starting, setStarting] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [copied, setCopied] = useState(false);
  const [ackTicked, setAckTicked] = useState(false);
  const [ackForced, setAckForced] = useState(false);
  const problemRef = useRef<HTMLDivElement | null>(null);
  const open = selection != null;
  // Keep the last selection on screen while the dialog fades out.
  const shown = useRef<SelectionSummary | null>(null);
  if (selection) shown.current = selection;
  const s = selection ?? shown.current;
  // The job this dialog started (an older one from before it opened is not its business).
  const [jobId, setJobId] = useState<string | null>(null);
  const mine = job != null && job.id === jobId ? job : null;
  const running = mine?.state === "running";
  const busy = starting || running;

  const key = selection ? selection.items.map((e) => e.path).join("\n") : "";
  // The delete check for the items (the outer ones: those inside them are checked with them), asked each time it opens.
  const advice = useDeleteAdvice(sparkId, selection ? selection.items.map((e) => e.path) : null);
  useEffect(() => {
    if (!selection) return;
    setTyped("");
    setStarting(false);
    setProblem(null);
    setCopied(false);
    setAckTicked(false);
    setAckForced(false);
    setAsAdmin(preferAdmin);
    setJobId(null);
    // Only when a different set of items is opened.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  // A run that ended without deleting anything, for a reason that can be fixed here: say what to do.
  const handled = useRef<string | null>(null);
  useEffect(() => {
    if (!mine || mine.state !== "done" || handled.current === mine.id || !bulkFixable(mine)) return;
    handled.current = mine.id;
    const code = mine.stopped?.code;
    const message = mine.stopped?.message ?? mine.failed[0]?.message ?? "The Spark refused the request";
    if (code === "bad-password") {
      access.forget();
      setProblem({ text: "The sudo password was not accepted. Check it and try again.", password: true });
    } else if (code === "no-ack") {
      setAsAdmin(true);
      setAckForced(true);
      setAckTicked(false);
      setProblem({ text: "Deleting folders as administrator is off for this Spark. Read the note below and confirm it to go on." });
    } else if (code === "no-sudo") {
      setAsAdmin(true);
      setProblem({ text: message, password: access.needsPassword });
    } else if (code === "password-locked") {
      setProblem({ text: message });
    } else {
      setAsAdmin(true);
      setProblem({
        text: `This account is not allowed to delete ${mine.failed.length === 1 ? "it" : "them"}. ${access.available ? "Run it as administrator to finish." : "Run the command below on the Spark to finish."}`,
      });
    }
  }, [mine, access]);

  // A new message must not be missed, even on a small window where the dialog scrolls.
  useEffect(() => {
    if (problem) problemRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [problem]);

  if (!s) return null;
  const count = s.items.length;
  const phrase = confirmPhrase(count);
  const typedOk = confirmMatches(typed, count);
  const adminOk = !asAdmin || access.ready;
  const anyFolder = s.folders > 0;
  // Deleting a folder as administrator needs the owner's acknowledgement for this Spark, as in the single dialog.
  const ackNeeded = anyFolder && access.sudo !== "root" && (!ack || ackForced);
  const canDelete = !busy && count > 0 && typedOk && adminOk && (!asAdmin || access.available) && (!asAdmin || !ackNeeded || ackTicked) && advice.satisfied;
  const manualCommand = `sudo rm -rf --one-file-system -- ${s.items.map((e) => shellQuote(e.path)).join(" ")}`;
  const needManualCommand = asAdmin && access.needsPassword && !access.canTypePassword && !access.saved;
  const listed = s.items.slice(0, BULK_LISTED);
  const more = count - listed.length;
  const step = mine ? Math.min(mine.done + 1, mine.total) : 0;
  const pct = mine && mine.total > 0 ? Math.round((mine.done / mine.total) * 100) : 0;

  const run = async () => {
    if (!canDelete) return;
    setStarting(true);
    setProblem(null);
    try {
      if (asAdmin && ackNeeded && ackTicked) {
        await acknowledgeElevatedDelete(sparkId, account);
        setAckForced(false);
        onAckChanged?.();
      }
      const started = await onStart(
        s.items.map((e) => e.path),
        access.elevation(asAdmin)
      );
      setJobId(started.id);
    } catch (err) {
      const code = err instanceof ApiError ? err.code : undefined;
      const message = err instanceof Error ? err.message : "The Spark refused the request";
      if (code === "bad-password") {
        access.forget();
        setProblem({ text: "The sudo password was not accepted. Check it and try again.", password: true });
      } else {
        setProblem({ text: message });
      }
    } finally {
      setStarting(false);
    }
  };
  const copyCommand = async () => {
    try {
      await navigator.clipboard.writeText(manualCommand);
      setCopied(true);
    } catch {
      // Plain-http pages have no clipboard API: the box below is selectable.
      setCopied(false);
    }
  };

  const label = running
    ? `Deleting ${step} of ${mine!.total}…`
    : starting
      ? "Starting…"
      : asAdmin
        ? `Delete ${count} as administrator`
        : s.freesNothing
          ? "Delete anyway (frees nothing)"
          : `Delete ${count} permanently`;

  return (
    <StorageDialog
      open={open}
      busy={busy}
      onClose={onClose}
      title={`Delete ${count} item${count === 1 ? "" : "s"}?`}
      icon={<TrashIcon className="h-4 w-4 shrink-0" />}
      footer={
        <>
          <button type="button" className="btn btn--ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn btn--danger st-bulk__go" onClick={() => void run()} disabled={!canDelete}>
            <TrashIcon className="h-3.5 w-3.5" />
            {label}
          </button>
        </>
      }
    >
      <div className="st-target st-bulk">
        <div className="st-bulk__head">
          <b>
            {count} item{count === 1 ? "" : "s"}
          </b>{" "}
          · <b>{formatBytes(s.bytes)}</b> on {sparkName} · deleting frees about <b className={s.freesNothing ? "is-zero" : undefined}>{formatBytes(s.frees)}</b>
        </div>
        <ul className="st-bulk__list" aria-label="Items to delete">
          <li className="st-bulk__cols" aria-hidden>
            <span />
            <span />
            <span>Size</span>
            <span>Frees</span>
          </li>
          {listed.map((e) => (
            <li key={e.path}>
              <span className="st-bulk__icon" aria-hidden>
                {e.type === "dir" ? <FolderIcon className="h-3.5 w-3.5" /> : e.type === "link" ? <LinkIcon className="h-3.5 w-3.5" /> : <FileIcon className="h-3.5 w-3.5" />}
              </span>
              <span className="st-bulk__name" title={e.path}>
                {baseName(e.path)}
                <span className="sr-only">, {e.type === "dir" ? "folder" : e.type === "link" ? "link" : "file"}</span>
              </span>
              <span className="st-bulk__size mono">{formatBytes(e.bytes)}</span>
              <span className={`st-bulk__frees mono${freesOf(e) < e.bytes ? " is-shared" : ""}`} title={`Deleting it frees ${formatBytes(freesOf(e))}`}>
                <span className="sr-only">frees </span>
                {formatBytes(freesOf(e))}
              </span>
            </li>
          ))}
        </ul>
        {more > 0 || s.covered > 0 ? (
          <div className="st-bulk__more">
            {more > 0 ? `and ${more} more` : null}
            {more > 0 && s.covered > 0 ? " · " : null}
            {s.covered > 0 ? `${s.covered} item${s.covered === 1 ? "" : "s"} inside selected folders ${s.covered === 1 ? "is" : "are"} included` : null}
          </div>
        ) : null}
      </div>

      {problem && !problem.password ? (
        // Right under the items, so a failure is seen at once whatever else is open below.
        <div className="modal-sheet__error st-problem" role="alert" ref={problemRef}>
          <AlertTriangleIcon className="h-3.5 w-3.5 shrink-0" />
          <span>{problem.text}</span>
        </div>
      ) : null}

      {s.shared > 0 ? (
        <div className={`st-shared-box${s.freesNothing ? " is-zero" : ""}`} role={s.freesNothing ? "alert" : "note"}>
          <b>{s.freesNothing ? "Deleting these will not free any space." : `${formatBytes(s.shared)} of this is shared.`}</b>
          <span>
            {s.freesNothing ? "All of it" : formatBytes(s.shared)} is hard-linked to files outside the selected items, so it stays on disk until every link is deleted.{" "}
            {s.freesNothing ? "Delete them only if you want to get rid of these names." : `About ${formatBytes(s.frees)} comes back.`}
          </span>
        </div>
      ) : null}

      <DeleteAdviceBlock advice={advice} sparkName={sparkName} many disabled={busy} onSubmit={() => void run()} />

      <div className="danger-box" role="alert">
        <b>This cannot be undone.</b>
        <span>
          {anyFolder ? "The items, and everything in the folders, are" : count === 1 ? "The file is" : "The files are"} deleted from the Spark&rsquo;s disk right away, one after
          another. There is no trash to restore from.
        </span>
      </div>

      {/* The typed phrase and, once the Spark works through the items, the progress: one place, one size. */}
      <div className="st-swap">
        <div className={`field st-bulk__confirm${running ? " is-off" : ""}`} inert={running} aria-hidden={running}>
          {/* Not a <label for>: clicking or dragging across a label's text moves focus to its input, which
              cancels the selection, and the phrase here is meant to be selected and copied. */}
          <div id="st-bulk-confirm-label" className="st-field-label">
            Type <b className="mono st-selectable">{phrase}</b> to confirm
          </div>
          <input
            id="st-bulk-confirm"
            aria-labelledby="st-bulk-confirm-label"
            type="text"
            className="field-input--mono"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            value={typed}
            disabled={busy}
            placeholder={phrase}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void run();
              }
            }}
          />
        </div>
        <div className={`st-bulk-progress${running ? "" : " is-off"}`} role="status" aria-live="polite" aria-hidden={!running}>
          <div className="st-bulk-progress__line">
            <b>{running ? `Deleting ${step} of ${mine!.total}…` : ""}</b>
            <span className="st-bulk-progress__name mono">{mine?.current ? baseName(mine.current) : ""}</span>
          </div>
          <span className="st-bulk-progress__bar" aria-hidden>
            <i style={{ ["--w" as string]: `${pct}%` }} />
          </span>
          <span className="st-bulk-progress__note">The Spark deletes them one at a time. It keeps going if you close or reload this page.</span>
        </div>
      </div>

      <label className="check-row">
        <input type="checkbox" checked={asAdmin} disabled={busy} onChange={(e) => setAsAdmin(e.target.checked)} />
        <span>
          Delete as administrator (sudo)
          <small className="st-hint"> Needed for files that belong to root or another account, such as Docker&rsquo;s.</small>
        </span>
      </label>

      {/* Always laid out, only shown when ticked: ticking the box then changes nothing about the dialog's size. */}
      <div className={`st-reserve${asAdmin ? "" : " is-off"}`} aria-hidden={!asAdmin} inert={!asAdmin}>
        {ackNeeded ? <AdminDeleteAckField account={account ?? "this account"} checked={ackTicked} disabled={busy || !asAdmin} onChange={setAckTicked} /> : null}
        <AdminFields
          access={access}
          disabled={busy || !asAdmin}
          purpose={`to delete ${count === 1 ? "this" : "these"}`}
          problem={problem?.password ? problem.text : null}
          autoFocus={problem != null && asAdmin}
          onSubmit={() => void run()}
        />
      </div>

      {needManualCommand ? (
        <div className="field">
          <label htmlFor="st-bulk-manual-cmd">Or run this in a terminal on the Spark</label>
          <textarea id="st-bulk-manual-cmd" className="st-command mono" readOnly rows={3} value={manualCommand} onFocus={(e) => e.currentTarget.select()} />
          <div>
            <button type="button" className="btn btn--sm" onClick={() => void copyCommand()}>
              <CopyIcon className="h-3.5 w-3.5" />
              {copied ? "Copied" : "Copy command"}
            </button>
          </div>
        </div>
      ) : null}
    </StorageDialog>
  );
}
