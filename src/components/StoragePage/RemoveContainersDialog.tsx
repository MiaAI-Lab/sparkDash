import { useEffect, useState } from "react";
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
        text: code === "bad-password" ? "The sudo password was not accepted. Check it and try again." : err instanceof Error ? err.message : "Docker refused the request",
        password: code === "bad-password" || code === "no-sudo",
      });
    }
  };

  return (
    <StorageDialog
      open={open}
      busy={busy}
      onClose={onClose}
      title={containers.length === 1 ? "Remove this container?" : `Remove ${containers.length} containers?`}
      icon={<BoxIcon className="h-4 w-4 shrink-0" />}
      footer={
        <>
          <button type="button" className="btn btn--ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn btn--danger" onClick={() => void run()} disabled={!canRun}>
            <TrashIcon className="h-3.5 w-3.5" />
            {busy ? "Removing…" : containers.length === 1 ? "Remove container" : `Remove ${containers.length} containers`}
          </button>
        </>
      }
    >
      <p className="modal-sheet__lead">
        <Tag tone="bad" className="st-class">Careful</Tag> {containers.length === 1 ? "This container is" : "These containers are"} stopped. Removing{" "}
        {containers.length === 1 ? "it" : "them"} deletes {containers.length === 1 ? "its" : "their"} writable layer: everything written inside{" "}
        {containers.length === 1 ? "it" : "them"} that is not in a volume. That may hold data you can&rsquo;t re-create. Volumes and the images are
        kept, and a container that started running again is skipped.
      </p>
      <ul className="st-imglist">
        {containers.slice(0, SHOWN).map((c) => {
          const img = imageById.get(c.imageId);
          const age = c.created ? formatSince(Date.parse(c.created)) : null;
          return (
            <li key={c.id}>
              <span className="st-imglist__name">{c.name}</span>
              <span className="st-imglist__id">{img ? imageName(img) : "image removed"}</span>
              <span className="st-imglist__size">{age ? `${age} old` : c.state}</span>
            </li>
          );
        })}
        {containers.length > SHOWN ? <li className="st-imglist__more">and {containers.length - SHOWN} more</li> : null}
      </ul>

      {images.length > 0 ? (
        <label className="check-row">
          <input type="checkbox" checked={alsoImages} disabled={busy} onChange={(e) => setAlsoImages(e.target.checked)} />
          <span>
            Also remove {images.length === 1 ? "the image" : `the ${images.length} images`} {images.length === 1 ? "it" : "they"} used, if nothing else uses{" "}
            {images.length === 1 ? "it" : "them"}
            <small className="st-hint">
              {" "}
              This is what frees the disk space. An image another container still uses is kept.
              {images.some(isBuiltHere)
                ? ` ${images.length === 1 ? "It was" : "Some were"} built here, not pulled: removing ${images.length === 1 ? "it" : "them"} may delete the only copy.`
                : ""}
            </small>
          </span>
        </label>
      ) : null}

      {asAdmin ? (
        <AdminFields
          access={access}
          disabled={busy}
          purpose="to run Docker as administrator"
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
