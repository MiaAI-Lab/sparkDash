import { useState } from "react";
import { revokeElevatedDelete } from "../../api/client";
import type { StorageElevatedDeleteAck } from "../../api/types";
import { ShieldIcon } from "../ui/icons";

/** What the owner confirms before administrator deletes may remove folders on a Spark (roadmap §3, §5.1). */
export function adminDeleteAckText(account: string): string {
  return `Processes running as ${account} are treated as having root access. Do not use administrator deletes on this Spark if software you do not trust runs as this account.`;
}

interface AdminDeleteAckFieldProps {
  account: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}

/**
 * The statement and its check box, inside a delete dialog the first time a folder is deleted as administrator
 * on a Spark. Ticking it stores the acknowledgement (per Spark and account) when the delete is started.
 */
export function AdminDeleteAckField({ account, checked, disabled, onChange }: AdminDeleteAckFieldProps) {
  return (
    <div className="st-ack" role="note">
      <b>Deleting folders as administrator is off for this Spark.</b>
      <span>{adminDeleteAckText(account)}</span>
      <label className="check-row">
        <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
        <span>I understand. Allow administrator deletes of folders on this Spark.</span>
      </label>
    </div>
  );
}

interface AdminDeleteAckNoteProps {
  sparkId: string;
  ack: StorageElevatedDeleteAck | null | undefined;
  account: string | null;
  onChanged: () => void;
}

/** On the Storage page while the acknowledgement exists: says so, and turns it off. */
export function AdminDeleteAckNote({ sparkId, ack, account, onChanged }: AdminDeleteAckNoteProps) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  if (!ack) return null;
  const who = ack.user ?? account ?? "this account";
  const since = new Date(ack.acknowledgedAt).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  const revoke = async () => {
    setBusy(true);
    setProblem(null);
    try {
      await revokeElevatedDelete(sparkId);
      onChanged();
    } catch (err) {
      setProblem(err instanceof Error ? err.message : "Could not turn it off");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="st-ack-note" role="status">
      <ShieldIcon className="h-3.5 w-3.5 shrink-0" />
      <span>
        Administrator deletes of folders are allowed on this Spark: processes running as <b>{who}</b> are treated as having root access (since {since}).
        {problem ? <span className="st-ack-note__problem"> {problem}</span> : null}
      </span>
      <button type="button" className="btn btn--sm btn--ghost" onClick={() => void revoke()} disabled={busy}>
        {busy ? "Turning off…" : "Turn off"}
      </button>
    </div>
  );
}
