import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ApiError } from "../../api/client";
import type { DockerContainer, DockerImage } from "../../api/types";
import { formatSince } from "../../shared/formatSince";
import { AlertTriangleIcon, BoxIcon, TrashIcon } from "../ui/icons";
import { Tag } from "../ui/Tag";
import { AdminFields } from "./AdminFields";
import { isBuiltHere } from "./dockerProvenance";
import { imageName } from "./RemoveImagesDialog";
import { StorageDialog } from "./StorageDialog";
import type { AdminAccess } from "./useAdminAccess";

const SHOWN = 6;

interface RemoveContainersDialogProps {
  /** Empty when closed. */
  containers: DockerContainer[];
  /** Images these containers were made from, for the "also remove the image" choice. */
  images: DockerImage[];
  /** Start with "also remove the image" ticked (the dialog was opened from an image). */
  alsoImagesDefault: boolean;
  asAdmin: boolean;
  access: AdminAccess;
  /** Does the removal. Throws an ApiError to keep the dialog open with the reason. */
  onConfirm: (alsoImages: boolean) => Promise<void>;
  onClose: () => void;
}

/** Confirm removing stopped containers, and optionally the images they leave behind. */
export function RemoveContainersDialog({ containers, images, alsoImagesDefault, asAdmin, access, onConfirm, onClose }: RemoveContainersDialogProps) {
  const { t } = useTranslation("storage");
  const open = containers.length > 0;
  const [alsoImages, setAlsoImages] = useState(alsoImagesDefault);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<{ text: string; password: boolean } | null>(null);

  useEffect(() => {
    if (open) {
      setAlsoImages(alsoImagesDefault);
      setBusy(false);
      setProblem(null);
    }
    // Reset only when the dialog opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const canRun = !busy && (!asAdmin || (access.ready && access.available));
  const imageById = new Map(images.map((i) => [i.id, i]));

  const run = async () => {
    if (!canRun) return;
    setBusy(true);
    setProblem(null);
    try {
      await onConfirm(alsoImages);
      setBusy(false);
    } catch (err) {
      setBusy(false);
      const code = err instanceof ApiError ? err.code : undefined;
      if (code === "bad-password") access.forget();
      setProblem({
        text: code === "bad-password" ? t("removeContainers.badPassword", { }) : err instanceof Error ? err.message : t("removeContainers.refused", { }),
        password: code === "bad-password" || code === "no-sudo",
      });
    }
  };

  return (
    <StorageDialog
      open={open}
      busy={busy}
      onClose={onClose}
      title={containers.length === 1 ? t("removeContainers.titleOne", { }) : t("removeContainers.titleOther", { count: containers.length })}
      icon={<BoxIcon className="h-4 w-4 shrink-0" />}
      footer={
        <>
          <button type="button" className="btn btn--ghost" onClick={onClose} disabled={busy}>
            {t("removeContainers.cancel", { })}
          </button>
          <button type="button" className="btn btn--danger" onClick={() => void run()} disabled={!canRun}>
            <TrashIcon className="h-3.5 w-3.5" />
            {busy ? t("removeContainers.removing", { }) : containers.length === 1 ? t("removeContainers.confirmOne", { }) : t("removeContainers.confirmOther", { count: containers.length })}
          </button>
        </>
      }
    >
      <p className="modal-sheet__lead">
        <Tag tone="bad" className="st-class">{t("removeContainers.careful", { })}</Tag> {containers.length === 1 ? t("removeContainers.leadOne", { }) : t("removeContainers.leadOther", { })}
      </p>
      <ul className="st-imglist">
        {containers.slice(0, SHOWN).map((c) => {
          const img = imageById.get(c.imageId);
          const age = c.created ? formatSince(Date.parse(c.created)) : null;
          return (
            <li key={c.id}>
              <span className="st-imglist__name">{c.name}</span>
              <span className="st-imglist__id">{img ? imageName(img, t) : t("removeContainers.imageRemoved")}</span>
              <span className="st-imglist__size">{age ? t("removeContainers.age", { age }) : c.state}</span>
            </li>
          );
        })}
        {containers.length > SHOWN ? <li className="st-imglist__more">{t("removeContainers.more", { count: containers.length - SHOWN })}</li> : null}
      </ul>

      {images.length > 0 ? (
        <label className="check-row">
          <input type="checkbox" checked={alsoImages} disabled={busy} onChange={(e) => setAlsoImages(e.target.checked)} />
          <span>
            {t("removeContainers.alsoImages", { count: images.length })}
            <small className="st-hint">
              {" "}
              {t("removeContainers.alsoImagesHint", { })}
              {images.some(isBuiltHere)
                ? t("removeContainers.builtWarning", { count: images.length })
                : ""}
            </small>
          </span>
        </label>
      ) : null}

      {asAdmin ? (
        <AdminFields
          access={access}
          disabled={busy}
          purpose={t("docker.adminPurpose")}
          problem={problem?.password ? problem.text : null}
          onSubmit={() => void run()}
        />
      ) : null}
      {problem && !problem.password ? (
        <div className="modal-sheet__error st-problem" role="alert">
          <AlertTriangleIcon className="h-3.5 w-3.5 shrink-0" />
          <span>{problem.text}</span>
        </div>
      ) : null}
    </StorageDialog>
  );
}
