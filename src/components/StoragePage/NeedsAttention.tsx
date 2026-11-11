import { useCallback, useEffect, useRef, useState } from "react";
import { acknowledgeElevatedDelete, ApiError, fetchStorageQuarantine, resolveStorageQuarantine } from "../../api/client";
import type { StorageElevatedDeleteAck, StorageQuarantineItem } from "../../api/types";
import { AlertTriangleIcon, FileIcon, FolderIcon, RotateIcon, TrashIcon } from "../ui/icons";
import { AdminDeleteAckField } from "./AdminDeleteAck";
import { AdminFields } from "./AdminFields";
import type { Notice } from "./FilesTab";
import { StorageDialog } from "./StorageDialog";
import { baseName } from "./storageTree";
import type { AdminAccess } from "./useAdminAccess";

/** `forget`: drop the record only; the Spark refuses it when anything is staged (it never deletes). */
type Action = "restore" | "delete" | "forget";

/** What is true about an item now, in a sentence. */
function stateText(item: StorageQuarantineItem): string {
  switch (item.state) {
    case "staged":
      return "A delete moved it aside and did not finish. It still takes space.";
    case "interrupted":
      return "Its delete stopped part way, so some of it may already be gone.";
    case "conflict":
      return item.reason ?? "It could not be put back because something new has its name.";
    case "in-place":
      return "The delete stopped before anything moved. It is still in its place.";
    case "gone":
      return "It is no longer there. Only the record of the unfinished delete is left.";
    case "unknown":
      return `Something else is where it was kept. Check ${item.stagedPath} on the Spark by hand.`;
    default:
      return `The record of this delete cannot be read. Check ${item.stagedPath} on the Spark by hand.`;
  }
}

/** Only the record is left: dismissing it changes nothing on the Spark. */
const recordOnly = (item: StorageQuarantineItem) => item.state === "in-place" || item.state === "gone";
const actionable = (item: StorageQuarantineItem) => item.state !== "unknown" && item.state !== "unreadable";

interface NeedsAttentionProps {
  sparkId: string;
  sparkName: string;
  access: AdminAccess;
  /** The account name on the Spark, for the administrator-delete statement. */
  account: string | null;
  ack: StorageElevatedDeleteAck | null | undefined;
  /** Changes whenever the list may have changed (after a delete, a refresh of the Spark's status). */
  refreshKey: unknown;
  onNotice: (notice: Notice) => void;
  /** Something on the Spark changed (disk use, the acknowledgement). */
  onChanged: () => void;
}

/**
 * Deletes that were moved aside on the Spark and never finished: the unit keeps them, with a record, until
 * someone puts them back or deletes them. Shown only when there is something to look at.
 */
export function NeedsAttention({ sparkId, sparkName, access, account, ack, refreshKey, onNotice, onChanged }: NeedsAttentionProps) {
  const [items, setItems] = useState<StorageQuarantineItem[]>([]);
  const [open, setOpen] = useState<{ item: StorageQuarantineItem; action: Action } | null>(null);
  const generation = useRef(0);

  const load = useCallback(async () => {
    const mine = ++generation.current;
    try {
      const res = await fetchStorageQuarantine(sparkId);
      if (mine === generation.current) setItems(res.items);
    } catch {
      // Not knowing is not "nothing to do": keep what is on screen.
    }
  }, [sparkId]);

  useEffect(() => {
    setItems([]);
    setOpen(null);
  }, [sparkId]);
  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const done = (item: StorageQuarantineItem, outcome: string | null) => {
    setOpen(null);
    const name = baseName(item.path);
    onNotice({
      tone: "ok",
      text:
        outcome === "restored"
          ? `Put ${name} back in its place.`
          : outcome === "deleted"
            ? `Deleted ${name}.`
            : `Cleared the record for ${name}. Nothing on the Spark changed.`,
    });
    void load();
    onChanged();
  };

  if (items.length === 0 && !open) return null;
  return (
    <section className="panel st-attention" aria-labelledby="st-attention-title">
      <div className="st-attention__head">
        <AlertTriangleIcon className="h-4 w-4 shrink-0" />
        <div>
          <h2 id="st-attention-title">Needs attention</h2>
          <p>
            {items.length === 1 ? "A delete" : `${items.length} deletes`} on {sparkName} did not finish. What was moved aside is kept until you put it back or
            delete it.
          </p>
        </div>
      </div>
      <ul className="st-attention__list">
        {items.map((item) => (
          <li key={item.id} className="st-attention__item">
            <span className="st-target__icon" aria-hidden>
              {item.type === "dir" ? <FolderIcon className="h-4 w-4" /> : <FileIcon className="h-4 w-4" />}
            </span>
            <div className="st-attention__main">
              <div className="st-target__name">{baseName(item.path)}</div>
              <div className="st-target__path mono" title={item.path}>
                {item.path}
              </div>
              <p className="st-attention__state">{stateText(item)}</p>
            </div>
            {actionable(item) ? (
              <div className="st-attention__actions">
                {recordOnly(item) ? (
                  <button type="button" className="btn btn--sm" onClick={() => setOpen({ item, action: "forget" })}>
                    Dismiss
                  </button>
                ) : (
                  <>
                    <button type="button" className="btn btn--sm" onClick={() => setOpen({ item, action: "restore" })}>
                      <RotateIcon className="h-3.5 w-3.5" />
                      Put back
                    </button>
                    <button type="button" className="btn btn--sm btn--danger" onClick={() => setOpen({ item, action: "delete" })}>
                      <TrashIcon className="h-3.5 w-3.5" />
                      Delete
                    </button>
                  </>
                )}
              </div>
            ) : null}
          </li>
        ))}
      </ul>
      <ResolveDialog
        sparkId={sparkId}
        target={open}
        access={access}
        account={account}
        ack={ack}
        onClose={() => setOpen(null)}
        onDone={done}
        onAckChanged={onChanged}
        onRefresh={() => void load()}
      />
    </section>
  );
}

interface ResolveDialogProps {
  sparkId: string;
  target: { item: StorageQuarantineItem; action: Action } | null;
  access: AdminAccess;
  account: string | null;
  ack: StorageElevatedDeleteAck | null | undefined;
  onClose: () => void;
  onDone: (item: StorageQuarantineItem, outcome: string | null) => void;
  onAckChanged: () => void;
  /** Read the list again (what the dialog was opened for is no longer true). */
  onRefresh: () => void;
}

/** Confirm putting one item back, deleting it, or dismissing its record. Same rules as the delete dialog. */
function ResolveDialog({ sparkId, target, access, account, ack, onClose, onDone, onAckChanged, onRefresh }: ResolveDialogProps) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<{ text: string; password?: boolean } | null>(null);
  const [ackTicked, setAckTicked] = useState(false);
  const [ackForced, setAckForced] = useState(false);
  const shown = useRef<ResolveDialogProps["target"]>(null);
  if (target) shown.current = target;
  const t = target ?? shown.current;

  useEffect(() => {
    if (!target) return;
    setBusy(false);
    setProblem(null);
    setAckTicked(false);
    setAckForced(false);
    // Only when a different item or action is opened.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target?.item.id, target?.action]);

  if (!t) return null;
  const { item, action } = t;
  const dismiss = action === "forget";
  // A staged item from an administrator delete belongs to root: putting it back or deleting it needs sudo.
  const asAdmin = item.elevated && !dismiss;
  const showAck = asAdmin && action === "delete" && item.type === "dir" && access.sudo !== "root" && (!ack || ackForced);
  const canRun = !busy && (!asAdmin || (access.available && access.ready)) && (!showAck || ackTicked);
  const name = baseName(item.path);

  const run = async () => {
    if (!canRun) return;
    setBusy(true);
    setProblem(null);
    try {
      if (showAck) {
        await acknowledgeElevatedDelete(sparkId, account);
        onAckChanged();
      }
      const res = await resolveStorageQuarantine(sparkId, item.id, action, access.elevation(asAdmin));
      setBusy(false);
      onDone(item, res.outcome);
    } catch (err) {
      setBusy(false);
      const code = err instanceof ApiError ? err.code : undefined;
      const message = err instanceof Error ? err.message : "The Spark refused the request";
      if (code === "bad-password") {
        access.forget();
        setProblem({ text: "The sudo password was not accepted. Check it and try again.", password: true });
      } else if (code === "payload-present") {
        // Something is staged again: the record is kept, and the list shows what can be done with it now.
        setProblem({ text: message });
        onRefresh();
      } else if (code === "no-ack") {
        setAckForced(true);
        setAckTicked(false);
        setProblem({ text: "Deleting folders as administrator is off for this Spark. Read the note below and confirm it to go on." });
      } else {
        setProblem({ text: message });
      }
    }
  };

  const title = dismiss ? "Dismiss this record?" : action === "restore" ? "Put this back?" : "Delete this for good?";
  return (
    <StorageDialog
      open={target != null}
      busy={busy}
      onClose={onClose}
      title={title}
      tone={action === "delete" && !dismiss ? "danger" : "neutral"}
      icon={action === "restore" ? <RotateIcon className="h-4 w-4 shrink-0" /> : <TrashIcon className="h-4 w-4 shrink-0" />}
      footer={
        <>
          <button type="button" className="btn btn--ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className={`btn ${action === "delete" && !dismiss ? "btn--danger" : "btn--primary"}`} onClick={() => void run()} disabled={!canRun}>
            {busy ? "Working…" : dismiss ? "Dismiss" : action === "restore" ? "Put back" : asAdmin ? "Delete as administrator" : "Delete permanently"}
          </button>
        </>
      }
    >
      <div className="st-target">
        <span className="st-target__icon" aria-hidden>
          {item.type === "dir" ? <FolderIcon className="h-5 w-5" /> : <FileIcon className="h-5 w-5" />}
        </span>
        <div className="min-w-0">
          <div className="st-target__name">{name}</div>
          <div className="st-target__path mono" title={item.path}>
            {item.path}
          </div>
          <div className="st-target__meta">{stateText(item)}</div>
        </div>
      </div>

      {problem && !problem.password ? (
        <div className="modal-sheet__error st-problem" role="alert">
          <AlertTriangleIcon className="h-3.5 w-3.5 shrink-0" />
          <span>{problem.text}</span>
        </div>
      ) : null}

      {dismiss ? (
        <p className="st-hint">Only the dashboard&rsquo;s record of the unfinished delete is removed. Nothing on the Spark changes.</p>
      ) : action === "restore" ? (
        <p className="st-hint">
          It goes back to <span className="mono">{item.path}</span>. If something new has that name now, nothing is replaced and it stays here.
        </p>
      ) : (
        <div className="danger-box" role="alert">
          <b>This cannot be undone.</b>
          <span>{item.type === "dir" ? "The folder and everything in it are" : "It is"} deleted from the Spark&rsquo;s disk, after the same safety checks as any delete.</span>
        </div>
      )}

      {showAck ? <AdminDeleteAckField account={account ?? "this account"} checked={ackTicked} disabled={busy} onChange={setAckTicked} /> : null}

      {asAdmin ? (
        <AdminFields
          access={access}
          disabled={busy}
          purpose={action === "restore" ? "to put this back" : "to delete this"}
          problem={problem?.password ? problem.text : null}
          onSubmit={() => void run()}
        />
      ) : null}
    </StorageDialog>
  );
}
