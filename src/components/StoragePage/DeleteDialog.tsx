import { useEffect, useRef, useState } from "react";
import { acknowledgeElevatedDelete, ApiError, deleteStoragePath } from "../../api/client";
import type { StorageElevatedDeleteAck } from "../../api/types";
import { formatBytes } from "../../shared/formatBytes";
import { AlertTriangleIcon, CopyIcon, FileIcon, FolderIcon, TrashIcon } from "../ui/icons";
import { AdminDeleteAckField } from "./AdminDeleteAck";
import { AdminFields } from "./AdminFields";
import { DeleteAdviceBlock } from "./DeleteAdvice";
import { StorageDialog } from "./StorageDialog";
import { baseName, shellQuote } from "./storageTree";
import type { AdminAccess } from "./useAdminAccess";
import { useDeleteAdvice } from "./useDeleteAdvice";

export interface DeleteTarget {
  path: string;
  type: "dir" | "file" | "link" | "other";
  bytes: number;
  /** Part of `bytes` that stays on disk because other hard links to it exist elsewhere. */
  sharedBytes?: number;
}

interface DeleteDialogProps {
  sparkId: string;
  sparkName: string;
  /** Null when closed. */
  target: DeleteTarget | null;
  access: AdminAccess;
  /** Start with administrator rights ticked, e.g. because the scan needed them to see this folder. */
  preferAdmin: boolean;
  onClose: () => void;
  onDeleted: (target: DeleteTarget) => void;
  /** The owner's acknowledgement that allows deleting folders as administrator on this Spark, if given. */
  ack?: StorageElevatedDeleteAck | null;
  /** The account name on the Spark, for that statement. */
  account?: string | null;
  /** The acknowledgement was just stored. */
  onAckChanged?: () => void;
  /** A delete failed: the Spark may now list something under "Needs attention". */
  onAttention?: () => void;
}

/** Refusals of an administrator delete that the person can still do by hand, with the command shown. */
const MANUAL_CODES = new Set(["staging-unavailable", "tree-writable-by-others"]);

interface Problem {
  text: string;
  /** The password field is what to fix. */
  password?: boolean;
}

/**
 * Confirm and run a permanent delete. A folder asks for its name to be typed. If the Spark refuses
 * because the account may not remove it, the dialog switches to "as administrator" and asks for the
 * sudo password when one is needed, so the same click path finishes the job. The delete check
 * (DeleteAdviceBlock) runs as the dialog opens and may ask for a tick or a typed phrase on top.
 */
export function DeleteDialog({ sparkId, sparkName, target, access, preferAdmin, onClose, onDeleted, ack = null, account = null, onAckChanged, onAttention }: DeleteDialogProps) {
  const [typed, setTyped] = useState("");
  const [asAdmin, setAsAdmin] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [copied, setCopied] = useState(false);
  // The administrator-delete statement: ticked in this dialog, or shown again because the Spark said it is off.
  const [ackTicked, setAckTicked] = useState(false);
  const [ackForced, setAckForced] = useState(false);
  // The Spark refused an administrator delete that can still be done by hand: show the command.
  const [manualShown, setManualShown] = useState(false);
  const problemRef = useRef<HTMLDivElement | null>(null);
  const open = target != null;
  // Keep the last target on screen while the dialog fades out.
  const shown = useRef<DeleteTarget | null>(null);
  if (target) shown.current = target;
  const t = target ?? shown.current;
  // Asked again each time the dialog opens; dropped when it closes.
  const advice = useDeleteAdvice(sparkId, target ? [target.path] : null);

  useEffect(() => {
    if (!target) return;
    setTyped("");
    setBusy(false);
    setProblem(null);
    setCopied(false);
    setAckTicked(false);
    setAckForced(false);
    setManualShown(false);
    setAsAdmin(preferAdmin);
    // Only when a different item is opened.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target?.path]);

  // A new message must not be missed, even on a small window where the dialog scrolls.
  useEffect(() => {
    if (problem) problemRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [problem]);

  if (!t) return null;
  const name = baseName(t.path);
  const isFolder = t.type === "dir";
  const typedOk = !isFolder || typed === name;
  const adminOk = !asAdmin || access.ready;
  const shared = Math.min(t.bytes, Math.max(0, t.sharedBytes ?? 0));
  const frees = Math.max(0, t.bytes - shared);
  // Everything in it is also linked from elsewhere: the delete will remove the names but give nothing back.
  const freesNone = t.bytes >= 1024 * 1024 && shared > 0 && frees < Math.max(1024 * 1024, t.bytes * 0.01);
  // Deleting a folder as administrator needs the owner's acknowledgement for this Spark (not when the dashboard
  // already is root there). Laid out with the administrator fields, so ticking "as administrator" moves nothing.
  const ackNeeded = isFolder && access.sudo !== "root" && (!ack || ackForced);
  const canDelete = !busy && typedOk && adminOk && (!asAdmin || access.available) && (!asAdmin || !ackNeeded || ackTicked) && advice.satisfied;
  const needManualCommand = (asAdmin && access.needsPassword && !access.canTypePassword && !access.saved) || manualShown;
  const manualCommand = `sudo rm -rf --one-file-system -- ${shellQuote(t.path)}`;

  const run = async () => {
    if (!canDelete) return;
    setBusy(true);
    setProblem(null);
    try {
      if (asAdmin && ackNeeded && ackTicked) {
        await acknowledgeElevatedDelete(sparkId, account);
        setAckForced(false);
        onAckChanged?.();
      }
      await deleteStoragePath(sparkId, { path: t.path, ...access.elevation(asAdmin) });
      setBusy(false);
      onDeleted(t);
    } catch (err) {
      setBusy(false);
      onAttention?.();
      const code = err instanceof ApiError ? err.code : undefined;
      const message = err instanceof Error ? err.message : "The Spark refused the request";
      const partial = err instanceof ApiError && err.partial;
      if (code === "no-ack") {
        setAsAdmin(true);
        setAckForced(true);
        setAckTicked(false);
        setProblem({ text: "Deleting folders as administrator is off for this Spark. Read the note below and confirm it to go on." });
      } else if (asAdmin && code && MANUAL_CODES.has(code)) {
        setManualShown(true);
        setProblem({ text: `${message} If you are sure, run the command below on the Spark yourself.` });
      } else if (code === "permission" && !asAdmin) {
        // The account may not remove it. Offer the administrator route right here.
        setAsAdmin(true);
        setProblem({
          text: `This account is not allowed to delete everything in here${partial ? " (some of it may already be gone)" : ""}. ${
            access.available ? "Run it as administrator to finish." : "Run the command below on the Spark to finish."
          }`,
        });
      } else if (code === "bad-password") {
        access.forget();
        setProblem({ text: "The sudo password was not accepted. Check it and try again.", password: true });
      } else if (code === "no-sudo") {
        setAsAdmin(true);
        setProblem({ text: message, password: access.needsPassword });
      } else if (code === "password-locked") {
        setProblem({ text: message });
      } else {
        setProblem({ text: partial ? `${message} Some of it may already be gone. Analyse again to see what is left.` : message });
      }
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

  return (
    <StorageDialog
      open={open}
      busy={busy}
      onClose={onClose}
      title={isFolder ? "Delete this folder?" : "Delete this file?"}
      icon={<TrashIcon className="h-4 w-4 shrink-0" />}
      footer={
        <>
          <button type="button" className="btn btn--ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn btn--danger" onClick={() => void run()} disabled={!canDelete}>
            <TrashIcon className="h-3.5 w-3.5" />
            {busy ? "Deleting…" : asAdmin ? "Delete as administrator" : freesNone ? "Delete anyway (frees nothing)" : "Delete permanently"}
          </button>
        </>
      }
    >
      <div className="st-target">
        <span className="st-target__icon" aria-hidden>
          {isFolder ? <FolderIcon className="h-5 w-5" /> : <FileIcon className="h-5 w-5" />}
        </span>
        <div className="min-w-0">
          <div className="st-target__name">{name}</div>
          <div className="st-target__path mono" title={t.path}>
            {t.path}
          </div>
          <div className="st-target__meta">
            <b>{formatBytes(t.bytes)}</b> on {sparkName} · deleting frees <b className={freesNone ? "is-zero" : undefined}>{formatBytes(frees)}</b>
          </div>
        </div>
      </div>

      {problem && !problem.password ? (
        // Right under the item, so a failure is seen at once whatever else is open below.
        <div className="modal-sheet__error st-problem" role="alert" ref={problemRef}>
          <AlertTriangleIcon className="h-3.5 w-3.5 shrink-0" />
          <span>{problem.text}</span>
        </div>
      ) : null}

      {shared > 0 ? (
        <div className={`st-shared-box${freesNone ? " is-zero" : ""}`} role={freesNone ? "alert" : "note"}>
          <b>{freesNone ? "Deleting this will not free any space." : `${formatBytes(shared)} of this is shared.`}</b>
          <span>
            {freesNone ? "All of it" : `${formatBytes(shared)}`} is hard-linked to files outside {isFolder ? "this folder" : "this file"} (another folder holds links to the same data), so it stays on
            disk until every link is deleted. {freesNone ? "Delete it only if you want to get rid of these names." : `Only ${formatBytes(frees)} comes back.`}
          </span>
        </div>
      ) : null}

      <DeleteAdviceBlock advice={advice} sparkName={sparkName} many={false} disabled={busy} onSubmit={() => void run()} />

      <div className="danger-box" role="alert">
        <b>This cannot be undone.</b>
        <span>
          {isFolder ? "The folder and everything in it are" : "The file is"} deleted from the Spark&rsquo;s disk right away. There is no trash to restore from.
        </span>
      </div>

      {isFolder ? (
        <div className="field">
          {/* Not a <label for>: clicking or dragging across a label's text moves focus to its input, which
              cancels the selection, and the name here is meant to be selected and copied. */}
          <div id="st-confirm-label" className="st-field-label">
            Type <b className="mono st-selectable">{name}</b> to confirm
          </div>
          <input
            id="st-confirm-name"
            aria-labelledby="st-confirm-label"
            type="text"
            className="field-input--mono"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            value={typed}
            disabled={busy}
            placeholder={name}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void run();
              }
            }}
          />
        </div>
      ) : null}

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
          purpose="to delete this"
          problem={problem?.password ? problem.text : null}
          autoFocus={problem != null && asAdmin}
          onSubmit={() => void run()}
        />
      </div>

      {needManualCommand ? (
        <div className="field">
          <label htmlFor="st-manual-cmd">Or run this in a terminal on the Spark</label>
          <textarea id="st-manual-cmd" className="st-command mono" readOnly rows={3} value={manualCommand} onFocus={(e) => e.currentTarget.select()} />
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
