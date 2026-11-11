import { useId } from "react";
import { LockIcon } from "../ui/icons";
import type { AdminAccess } from "./useAdminAccess";

interface AdminFieldsProps {
  access: AdminAccess;
  disabled?: boolean;
  /** What the password will be used for, in a few words: "to delete this folder". */
  purpose: string;
  /** Called when Enter is pressed in the password box. */
  onSubmit?: () => void;
  autoFocus?: boolean;
  /** Shown under the box in the warning colour, e.g. "That password was not accepted". */
  problem?: string | null;
}

/** The sudo password box (or the sentence that says none is needed) for an action run as administrator. */
export function AdminFields({ access, disabled, purpose, onSubmit, autoFocus, problem }: AdminFieldsProps) {
  const id = useId();
  if (access.sudo === "root") {
    return <p className="st-admin__note">The dashboard already runs as an administrator on this Spark. No password is needed.</p>;
  }
  if (access.sudo === "yes") {
    return <p className="st-admin__note">This Spark allows administrator actions without a password. No password is needed.</p>;
  }
  if (access.saved) {
    return (
      <div className="st-admin__saved">
        <p className="st-admin__note">
          <LockIcon className="h-3.5 w-3.5" /> The sudo password for this Spark is remembered on the dashboard (encrypted), so nothing needs typing. Anyone
          who can open the dashboard can use it until it is forgotten.
        </p>
        <button type="button" className="btn btn--sm btn--ghost" onClick={() => void access.forgetSaved()} disabled={disabled}>
          Forget password
        </button>
      </div>
    );
  }
  if (!access.canTypePassword) {
    return (
      <p className="st-admin__note is-warn">
        This Spark asks for a sudo password, and this connection is not private (plain http from another machine), so it
        cannot be typed here. Open the dashboard over https or from the Spark itself, turn on Settings &rarr; Allow sudo
        password over plain http (only on a network you trust), or run the command in a terminal on the Spark.
      </p>
    );
  }
  return (
    <div className="field st-admin__field">
      <label htmlFor={id}>
        <LockIcon className="h-3.5 w-3.5" /> sudo password {purpose}
      </label>
      <div className="st-admin__row">
        <input
          id={id}
          type="password"
          autoComplete="new-password"
          data-1p-ignore
          data-lpignore="true"
          value={access.password}
          disabled={disabled}
          autoFocus={autoFocus}
          placeholder="Your password on the Spark"
          aria-invalid={problem ? true : undefined}
          onChange={(e) => access.setPassword(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && onSubmit) {
              e.preventDefault();
              onSubmit();
            }
          }}
        />
        {access.password ? (
          <button type="button" className="btn btn--sm btn--ghost" onClick={access.forget} disabled={disabled}>
            Forget
          </button>
        ) : null}
      </div>
      {problem ? (
        <p className="field-hint is-warn" role="alert">
          {problem}
        </p>
      ) : null}
      <label className="check-row st-admin__remember">
        <input type="checkbox" checked={access.remember} disabled={disabled} onChange={(e) => access.setRemember(e.target.checked)} />
        <span>Remember it on this dashboard</span>
      </label>
      {/* Always laid out (hidden until "remember" is ticked) so ticking it does not move anything. */}
      <p className={`field-hint st-admin__rememberhint${access.remember ? "" : " is-off"}`} aria-hidden={!access.remember}>
        Kept encrypted on the dashboard server, so you are not asked again, even after a reload. Anyone who can open this dashboard can then use it
        on this Spark.
      </p>
    </div>
  );
}
