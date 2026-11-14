import { useId } from "react";
import { useTranslation } from "react-i18next";
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
  const { t } = useTranslation("storage");
  const id = useId();
  if (access.sudo === "root") {
    return <p className="st-admin__note">{t("admin.alreadyRoot")}</p>;
  }
  if (access.sudo === "yes") {
    return <p className="st-admin__note">{t("admin.passwordless")}</p>;
  }
  if (access.saved) {
    return (
      <div className="st-admin__saved">
        <p className="st-admin__note">
          <LockIcon className="h-3.5 w-3.5" /> {t("admin.saved")}
        </p>
        <button type="button" className="btn btn--sm btn--ghost" onClick={() => void access.forgetSaved()} disabled={disabled}>
          {t("admin.forgetPassword")}
        </button>
      </div>
    );
  }
  if (!access.canTypePassword) {
    return (
      <p className="st-admin__note is-warn">
        {t("admin.cannotType")}
      </p>
    );
  }
  return (
    <div className="field st-admin__field">
      <label htmlFor={id}>
        <LockIcon className="h-3.5 w-3.5" /> {t("admin.passwordLabel", { purpose })}
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
          placeholder={t("admin.passwordPlaceholder")}
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
            {t("admin.forget")}
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
        <span>{t("admin.remember")}</span>
      </label>
      {/* Always laid out (hidden until "remember" is ticked) so ticking it does not move anything. */}
      <p className={`field-hint st-admin__rememberhint${access.remember ? "" : " is-off"}`} aria-hidden={!access.remember}>
        {t("admin.rememberHint")}
      </p>
    </div>
  );
}
