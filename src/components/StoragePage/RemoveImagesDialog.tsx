import { useEffect, useMemo, useState } from "react";
import { ApiError, removeDockerImages } from "../../api/client";
import type { DockerImage, DockerRemoveResult, SparkSnapshot } from "../../api/types";
import { formatBytes } from "../../shared/formatBytes";
import { AlertTriangleIcon, BoxIcon, TrashIcon } from "../ui/icons";
import { Tag } from "../ui/Tag";
import { AdminFields } from "./AdminFields";
import { PeersBlock, toggled, usePeerDockerLists, type PeerRowView } from "./dockerPeers";
import { BUILT_HERE_TITLE, isBuiltHere } from "./dockerProvenance";
import { StorageDialog } from "./StorageDialog";
import type { AdminAccess } from "./useAdminAccess";

export const imageName = (img: DockerImage) => img.tags[0] ?? "Untagged image";
export const shortId = (id: string) => id.replace(/^sha256:/, "").slice(0, 12);

const SHOWN = 6;

/** What happened on another Spark when its copies were removed too. */
export interface PeerOutcome {
  text: string;
  failed: boolean;
}

/** One other Spark and what it holds of the selected images. */
interface Peer {
  spark: SparkSnapshot;
  state: "loading" | "ready" | "error";
  /** The selected images this Spark also has (same image ID). */
  matching: DockerImage[];
  /** Of those, the ones nothing uses there: the only ones that can go. */
  removable: DockerImage[];
  /** Docker there needed administrator rights, so removal asks for them too. */
  elevate: boolean;
  error?: string;
}

/** How one other Spark reads in the dialog: what it holds of the selected images and what would go there. */
function peerRow(p: Peer, selected: number): PeerRowView {
  const has = p.state === "ready" && p.matching.length > 0;
  const detail =
    p.state === "loading"
      ? "Checking…"
      : p.state === "error"
        ? `Could not be checked: ${p.error}`
        : !has
          ? "Does not have this image."
          : p.removable.length === p.matching.length
            ? `None is used there${p.elevate ? " (removed as administrator)" : ""}.`
            : p.removable.length === 0
              ? "Used by containers there, so it would be kept."
              : `${p.removable.length} unused will go; ${p.matching.length - p.removable.length} used are kept.`;
  const title = has ? `${p.matching.length === selected ? "has all" : `has ${p.matching.length} of`} ${selected === 1 ? "this image" : `these ${selected} images`}` : "";
  return {
    id: p.spark.id,
    name: p.spark.name,
    title,
    detail,
    tone: p.state === "error" ? "error" : p.state === "ready" && !has ? "none" : undefined,
    selectable: has && p.removable.length > 0,
  };
}

interface RemoveImagesDialogProps {
  sparkId: string;
  /** The other Sparks that could hold the same images (a cluster usually has copies on every node). */
  peers: SparkSnapshot[];
  /** Empty when closed. */
  images: DockerImage[];
  /** What removing them frees, worded for the sentence "frees ...". */
  estimate: string;
  /** Docker needs administrator rights on this Spark. */
  asAdmin: boolean;
  access: AdminAccess;
  onClose: () => void;
  onDone: (result: DockerRemoveResult, peerOutcomes: PeerOutcome[]) => void;
}

/** Confirm removing unused Docker images. Only images no container uses can be chosen. */
export function RemoveImagesDialog({ sparkId, peers: peerSparks, images, estimate, asAdmin, access, onClose, onDone }: RemoveImagesDialogProps) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<{ text: string; password: boolean } | null>(null);
  const open = images.length > 0;
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const imageKey = images.map((i) => i.id).join(",");

  useEffect(() => {
    if (open) {
      setBusy(false);
      setProblem(null);
      setPicked(new Set());
    }
  }, [open]);

  // Which of the other Sparks hold the same images, and whether anything there uses them. Read-only; read again
  // when the dialog opens for a different set of images or Sparks.
  const lists = usePeerDockerLists(open, peerSparks, imageKey);
  const peers: Peer[] = useMemo(() => {
    const ids = new Set(images.map((i) => i.id));
    return lists.map((l) => {
      if (l.state !== "ready" || !l.data) return { spark: l.spark, state: l.state, matching: [], removable: [], elevate: l.elevate, error: l.error };
      const matching = l.data.images.filter((i) => ids.has(i.id));
      return { spark: l.spark, state: "ready", matching, removable: matching.filter((i) => i.status === "unused"), elevate: l.elevate };
    });
  }, [lists, images]);

  const togglePeer = (id: string) => setPicked((prev) => toggled(prev, id));

  const canRun = !busy && (!asAdmin || (access.ready && access.available));
  const builtCount = images.filter(isBuiltHere).length;

  const run = async () => {
    if (!canRun) return;
    setBusy(true);
    setProblem(null);
    try {
      const result = await removeDockerImages(sparkId, { ids: images.map((i) => i.id), ...access.elevation(asAdmin) });
      // This Spark is done. Then the same images on the other Sparks that were ticked; one failing does not stop the rest.
      const outcomes: PeerOutcome[] = [];
      for (const peer of peers.filter((p) => picked.has(p.spark.id))) {
        const ids = peer.removable.map((i) => i.id);
        if (ids.length === 0) {
          outcomes.push({ text: `${peer.spark.name}: every copy is in use there, so none were removed.`, failed: false });
          continue;
        }
        try {
          const r = await removeDockerImages(peer.spark.id, { ids, ...(peer.elevate ? { sudo: true } : {}) });
          const extra = [r.skipped.length > 0 ? `${r.skipped.length} skipped` : "", r.failed.length > 0 ? `${r.failed.length} failed` : ""].filter(Boolean).join(", ");
          outcomes.push({ text: `${peer.spark.name}: removed ${r.removed.length} image${r.removed.length === 1 ? "" : "s"}${extra ? ` (${extra})` : ""}.`, failed: r.failed.length > 0 });
        } catch (err) {
          outcomes.push({ text: `${peer.spark.name}: could not remove (${err instanceof Error ? err.message : "Docker refused"}).`, failed: true });
        }
      }
      setBusy(false);
      onDone(result, outcomes);
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
      title={images.length === 1 ? "Remove this image?" : `Remove ${images.length} images?`}
      icon={<BoxIcon className="h-4 w-4 shrink-0" />}
      footer={
        <>
          <button type="button" className="btn btn--ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn btn--danger" onClick={() => void run()} disabled={!canRun}>
            <TrashIcon className="h-3.5 w-3.5" />
            {busy ? "Removing…" : images.length === 1 ? "Remove image" : `Remove ${images.length} images`}
          </button>
        </>
      }
    >
      <p className="modal-sheet__lead">
        <Tag tone="warn" className="st-class">Review first</Tag> No container uses {images.length === 1 ? "this image" : "these images"}. Removing{" "}
        {images.length === 1 ? "it" : "them"} frees <b>{estimate}</b>. A pulled image comes back only by pulling it again, while its registry still
        has it; one built here has to be built again. Containers, volumes and your files are not touched.
      </p>
      <ul className="st-imglist">
        {images.slice(0, SHOWN).map((img) => (
          <li key={img.id}>
            <span className="st-imglist__name">{imageName(img)}</span>
            <span className="st-imglist__id mono">
              {shortId(img.id)}
              {isBuiltHere(img) ? (
                <span className="st-imglist__built" title={BUILT_HERE_TITLE}>
                  {" "}
                  · built here
                </span>
              ) : null}
            </span>
            <span className="st-imglist__size mono">{formatBytes(img.sizeBytes)}</span>
          </li>
        ))}
        {images.length > SHOWN ? <li className="st-imglist__more">and {images.length - SHOWN} more</li> : null}
      </ul>
      <p className="st-hint">
        {builtCount > 0
          ? `${builtCount === images.length ? (images.length === 1 ? "It was" : "All were") : `${builtCount} of them ${builtCount === 1 ? "was" : "were"}`} built here, not pulled: removing ${builtCount === 1 ? "it" : "them"} may delete the only copy. `
          : ""}
        If an image gets a container before this runs, it is skipped.
      </p>
      {peerSparks.length > 0 ? (
        <PeersBlock
          hint="Clusters usually keep the same images on every node. Tick the Sparks to clean up too."
          rows={peers.map((p) => peerRow(p, images.length))}
          picked={picked}
          busy={busy}
          onToggle={togglePeer}
        />
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
