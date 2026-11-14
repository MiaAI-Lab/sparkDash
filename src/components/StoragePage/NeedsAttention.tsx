import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
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
function stateText(item: StorageQuarantineItem, t: ReturnType<typeof useTranslation>["t"]): string {
  switch (item.state) {
    case "staged":
      return t("recovery.state.staged");
    case "interrupted":
      return t("recovery.state.interrupted");
    case "conflict":
      return item.reason ?? t("recovery.state.conflict");
    case "in-place":
      return t("recovery.state.inPlace");
    case "gone":
      return t("recovery.state.gone");
    case "unknown":
      return t("recovery.state.unknown", { path: item.stagedPath });
    default:
      return t("recovery.state.unreadable", { path: item.stagedPath });
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
  const { t } = useTranslation("storage");
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
          <h2 id="st-attention-title">{t("recovery.title")}</h2>
          <p>
            {t("recovery.intro", { count: items.length, sparkName })}
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
              <p className="st-attention__state">{stateText(item, t)}</p>
            </div>
            {actionable(item) ? (
              <div className="st-attention__actions">
                {recordOnly(item) ? (
                  <button type="button" className="btn btn--sm" onClick={() => setOpen({ item, action: "forget" })}>
                    {t("recovery.dismiss")}
                  </button>
                ) : (
                  <>
                    <button type="button" className="btn btn--sm" onClick={() => setOpen({ item, action: "restore" })}>
                      <RotateIcon className="h-3.5 w-3.5" />
                      {t("recovery.putBack")}
                    </button>
                    <button type="button" className="btn btn--sm btn--danger" onClick={() => setOpen({ item, action: "delete" })}>
                      <TrashIcon className="h-3.5 w-3.5" />
                      {t("recovery.delete")}
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
  const { t } = useTranslation("storage");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<{ text: string; password?: boolean } | null>(null);
  const [ackTicked, setAckTicked] = useState(false);
  const [ackForced, setAckForced] = useState(false);
  const shown = useRef<ResolveDialogProps["target"]>(null);
  if (target) shown.current = target;
  const activeTarget = target ?? shown.current;

  useEffect(() => {
    if (!target) return;
    setBusy(false);
    setProblem(null);
    setAckTicked(false);
    setAckForced(false);
    // Only when a different item or action is opened.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target?.item.id, target?.action]);

  if (!activeTarget) return null;
  const { item, action } = activeTarget;
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
        setProblem({ text: t("deletion.badPassword"), password: true });
      } else if (code === "payload-present") {
        // Something is staged again: the record is kept, and the list shows what can be done with it now.
        setProblem({ text: message });
        onRefresh();
      } else if (code === "no-ack") {
        setAckForced(true);
        setAckTicked(false);
        setProblem({ text: t("deletion.ackRequired") });
      } else {
        setProblem({ text: message });
      }
    }
  };

  const title = dismiss ? t("recovery.dismissTitle") : action === "restore" ? t("recovery.restoreTitle") : t("recovery.deleteTitle");
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
            {t("deletion.cancel")}
          </button>
          <button type="button" className={`btn ${action === "delete" && !dismiss ? "btn--danger" : "btn--primary"}`} onClick={() => void run()} disabled={!canRun}>
            {busy ? t("deletion.working") : dismiss ? t("recovery.dismiss") : action === "restore" ? t("recovery.putBack") : asAdmin ? t("deletion.deleteAsAdmin") : t("deletion.deletePermanently")}
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
          <div className="st-target__meta">{stateText(item, t)}</div>
        </div>
      </div>

      {problem && !problem.password ? (
        <div className="modal-sheet__error st-problem" role="alert">
          <AlertTriangleIcon className="h-3.5 w-3.5 shrink-0" />
          <span>{problem.text}</span>
        </div>
      ) : null}

      {dismiss ? (
        <p className="st-hint">{t("recovery.recordOnly")}</p>
      ) : action === "restore" ? (
        <p className="st-hint">
          {t("recovery.restoreHint", { path: item.path })}
        </p>
      ) : (
        <div className="danger-box" role="alert">
          <b>{t("deletion.cannotUndo")}</b>
          <span>{t("recovery.deleteWarning", { target: item.type === "dir" ? t("recovery.folderAndContents") : t("recovery.it") })}</span>
        </div>
      )}

      {showAck ? <AdminDeleteAckField account={account ?? "this account"} checked={ackTicked} disabled={busy} onChange={setAckTicked} /> : null}

      {asAdmin ? (
        <AdminFields
          access={access}
          disabled={busy}
          purpose={action === "restore" ? t("recovery.restorePurpose") : t("recovery.deletePurpose")}
          problem={problem?.password ? problem.text : null}
          onSubmit={() => void run()}
        />
      ) : null}
    </StorageDialog>
  );
}
