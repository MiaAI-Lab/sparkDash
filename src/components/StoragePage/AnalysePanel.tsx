import { useId } from "react";
import { useTranslation } from "react-i18next";
import type { StorageStatus } from "../../api/types";
import { AlertTriangleIcon, BoxIcon, DiskIcon, FolderIcon, SearchIcon, ShieldIcon } from "../ui/icons";
import { FolderPicker } from "./FolderPicker";
import { AdminFields } from "./AdminFields";
import type { AdminAccess } from "./useAdminAccess";

export type LocationId = "disk" | "home" | "cache" | "custom";

/**
 * The home folder to offer: the dashboard account's own, or, when that account is root, the first ordinary
 * person's folder under /home (never /root). Null when there is none, and the choice is then not offered.
 */
export function homePath(status: StorageStatus): string | null {
  if (status.user && status.user !== "root") return status.homeDir ?? `/home/${status.user}`;
  return status.peopleHomes?.[0] ?? null;
}

/** The folder to scan for a choice, or null when a folder has not been chosen yet. */
export function locationPath(id: LocationId, custom: string, status: StorageStatus): string | null {
  if (id === "disk") return "/";
  if (id === "home") return homePath(status);
  if (id === "cache") {
    const home = homePath(status);
    return home ? `${home}/.cache` : null;
  }
  const text = custom.trim().replace(/\/+$/, "");
  return text.startsWith("/") ? text || "/" : null;
}

const OPTIONS: { id: LocationId; icon: typeof DiskIcon }[] = [
  { id: "disk", icon: DiskIcon },
  { id: "home", icon: FolderIcon },
  { id: "cache", icon: BoxIcon },
  { id: "custom", icon: SearchIcon },
];

function optionCopy(id: LocationId, t: (key: string) => string) {
  switch (id) {
    case "disk":
      return { title: t("analyse.options.disk.title"), hint: t("analyse.options.disk.hint") };
    case "home":
      return { title: t("analyse.options.home.title"), hint: t("analyse.options.home.hint") };
    case "cache":
      return { title: t("analyse.options.cache.title"), hint: t("analyse.options.cache.hint") };
    case "custom":
      return { title: t("analyse.options.custom.title"), hint: t("analyse.options.custom.hint") };
  }
}

interface AnalysePanelProps {
  sparkId: string;
  sparkName: string;
  status: StorageStatus;
  access: AdminAccess;
  location: LocationId;
  onLocation: (id: LocationId) => void;
  custom: string;
  onCustom: (text: string) => void;
  asAdmin: boolean;
  onAsAdmin: (on: boolean) => void;
  /** Starting is not possible right now (a scan or delete is running). */
  disabled: boolean;
  onAnalyse: () => void;
  /** Why the last attempt failed, if it did. */
  problem: string | null;
  /** Shown when there is a previous result to go back to. */
  onBack?: () => void;
  /** Why starting is not possible right now (the Spark is still busy with a scan), read out with the button. */
  busyNote?: string | null;
}

/** "Where should I look?": the start of an analysis. */
export function AnalysePanel(props: AnalysePanelProps) {
  const { t } = useTranslation("storage");
  const { sparkId, sparkName, status, access, location, onLocation, custom, onCustom, asAdmin, onAsAdmin, disabled, onAnalyse, problem, onBack, busyNote } = props;
  const groupId = useId();
  const path = locationPath(location, custom, status);
  const adminLocked = status.sudo === "root";
  const canAnalyse = !disabled && path != null && (!asAdmin || access.ready) && (!asAdmin || access.available);
  const hasHome = homePath(status) != null;
  const options = OPTIONS.filter((o) => hasHome || (o.id !== "home" && o.id !== "cache"));

  return (
    <section className="panel st-analyse" aria-labelledby={`${groupId}-title`}>
      <header className="st-analyse__head">
        <h2 id={`${groupId}-title`}>{t("analyse.title", { sparkName })}</h2>
        <p>{t("analyse.description")}</p>
      </header>

      <div className="st-choices" role="radiogroup" aria-label={t("analyse.whereToLook")}>
        {options.map((o) => {
          const Icon = o.icon;
          const copy = optionCopy(o.id, t);
          const optionPath = o.id === "custom" ? null : locationPath(o.id, custom, status);
          return (
            <button
              key={o.id}
              type="button"
              role="radio"
              aria-checked={location === o.id}
              className={`st-choice${location === o.id ? " is-active" : ""}`}
              onClick={() => onLocation(o.id)}
            >
              <span className="st-choice__icon" aria-hidden>
                <Icon className="h-4 w-4" />
              </span>
              <span className="st-choice__body">
                <span className="st-choice__title">{copy.title}</span>
                {optionPath ? <span className="st-choice__path mono">{optionPath}</span> : null}
                <span className="st-choice__hint">{copy.hint}</span>
              </span>
            </button>
          );
        })}
      </div>

      {location === "custom" ? (
        <div className="st-analyse__custom">
          <FolderPicker sparkId={sparkId} value={custom} onChange={onCustom} startAt={homePath(status) ?? "/"} disabled={disabled} />
        </div>
      ) : null}

      <div className={`st-admin${asAdmin ? " is-on" : ""}`}>
        <label className="st-switch">
          <input
            type="checkbox"
            checked={asAdmin || adminLocked}
            disabled={adminLocked || disabled || !access.available}
            onChange={(e) => onAsAdmin(e.target.checked)}
          />
          <span className="st-switch__track" aria-hidden />
          <span className="st-switch__label">
            <b>
              <ShieldIcon className="h-3.5 w-3.5" /> {t("analyse.includeProtected")}
            </b>
            <small>
              {t("analyse.includeProtectedHint")}
            </small>
          </span>
        </label>
        {asAdmin && !adminLocked ? <AdminFields access={access} disabled={disabled} purpose={t("analyse.readProtectedPurpose")} onSubmit={onAnalyse} /> : null}
        {!access.available && !adminLocked ? (
          <p className="st-admin__note is-warn">
            {t("analyse.insecureSudoNotice")}
          </p>
        ) : null}
      </div>

      {problem ? (
        <div className="modal-sheet__error st-problem" role="alert">
          <AlertTriangleIcon className="h-3.5 w-3.5 shrink-0" />
          <span>{problem}</span>
        </div>
      ) : null}

      {busyNote ? (
        <p className="st-analyse__busy" id={`${groupId}-busy`}>
          {busyNote}
        </p>
      ) : null}

      <div className="st-analyse__actions">
        {onBack ? (
          <button type="button" className="btn btn--ghost" onClick={onBack}>
            {t("analyse.backToResults")}
          </button>
        ) : null}
        <button
          type="button"
          className="btn btn--primary st-analyse__go"
          onClick={onAnalyse}
          disabled={!canAnalyse}
          aria-describedby={busyNote ? `${groupId}-busy` : undefined}
        >
          <SearchIcon className="h-3.5 w-3.5" />
          {t("analyse.submit")}
        </button>
      </div>
    </section>
  );
}
