import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, fetchDockerStorage, removeDockerContainers, removeDockerImages } from "../../api/client";
import type { DockerContainer, DockerImage, DockerRemoveResult, DockerStorage, DockerUsageRow, SparkSnapshot } from "../../api/types";
import { formatBytes } from "../../shared/formatBytes";
import { formatSince } from "../../shared/formatSince";
import { BoxIcon, RotateIcon, ShieldIcon, TrashIcon } from "../ui/icons";
import { Tag } from "../ui/Tag";
import { AdminFields } from "./AdminFields";
import { Banner } from "./Banner";
import type { Notice } from "./FilesTab";
import { RemoveContainersDialog } from "./RemoveContainersDialog";
import { RemoveImagesDialog, imageName, shortId, type PeerOutcome } from "./RemoveImagesDialog";
import { BuiltHereTag, isBuiltHere } from "./dockerProvenance";
import { QuickCleanup } from "./QuickCleanup";
import type { AdminAccess } from "./useAdminAccess";

type Filter = "all" | "unused" | "used";

const TILES: { key: keyof DockerStorage["usage"]; label: string; noun: string; hint: string }[] = [
  { key: "images", label: "Images", noun: "images", hint: "Downloaded or built images. Unused ones can be removed below." },
  { key: "containers", label: "Containers", noun: "containers", hint: "Running and stopped containers, with the files they wrote." },
  { key: "volumes", label: "Volumes", noun: "volumes", hint: "Data kept for containers. Not touched here." },
  { key: "buildCache", label: "Build cache", noun: "entries", hint: "Layers kept to speed up builds. Clear it with docker builder prune." },
];

function Tile({ label, noun, hint, row }: { label: string; noun: string; hint: string; row: DockerUsageRow }) {
  return (
    <div className="st-tile" title={hint}>
      <span className="st-tile__label">{label}</span>
      <span className="st-tile__size mono">{formatBytes(row.sizeBytes)}</span>
      <span className="st-tile__sub">
        {row.count ?? "?"} {noun}
        {row.reclaimableBytes ? <> · {formatBytes(row.reclaimableBytes)} reclaimable</> : null}
      </span>
    </div>
  );
}

function statusTag(img: DockerImage) {
  if (img.status === "running") return <Tag tone="good">In use</Tag>;
  if (img.status === "stopped") return <Tag tone="warn">Stopped container</Tag>;
  // The Spark could not list its containers: never offered for removal.
  if (img.status === "unknown") return <Tag tone="warn">Usage unknown</Tag>;
  return <Tag tone="acc">Unused</Tag>;
}

/**
 * What removing images frees. Image sizes overlap (they share layers), so adding them up overstates it a lot.
 * Docker's own "reclaimable" figure counts shared layers once; it is only valid for removing every unused image.
 */
function freeEstimate(chosen: DockerImage[], unused: DockerImage[], reclaimableBytes: number | null | undefined): string {
  const combined = chosen.reduce((sum, i) => sum + (i.sizeBytes ?? 0), 0);
  const everyUnused = chosen.length > 0 && chosen.length === unused.length;
  if (everyUnused && reclaimableBytes != null) return `about ${formatBytes(reclaimableBytes)} (Docker's estimate)`;
  return `less than their combined ${formatBytes(combined)}, because images share layers`;
}

function usedByText(img: DockerImage): string {
  const names = img.usedBy.slice(0, 3).map((c) => c.name);
  const more = img.usedBy.length - names.length;
  return `Used by ${names.join(", ")}${more > 0 ? ` and ${more} more` : ""}`;
}

function ContainerRow({ container: c, image, selected, onToggle }: { container: DockerContainer; image: DockerImage | undefined; selected: boolean; onToggle: (id: string) => void }) {
  const created = c.created ? formatSince(Date.parse(c.created)) : null;
  return (
    <li className={`st-img st-img--container${selected ? " is-selected" : ""}${c.removable ? "" : " is-locked"}`}>
      {/* The label is the tap target (44 px on touch layouts); the box itself stays small. */}
      <label className="st-img__hit">
        <input
          type="checkbox"
          className="st-img__check"
          checked={selected}
          disabled={!c.removable}
          onChange={() => onToggle(c.id)}
          aria-label={`Select container ${c.name}`}
          title={c.removable ? undefined : "Running. Stop it first."}
        />
      </label>
      <div className="st-img__main">
        <span className="st-img__name">{c.name}</span>
        <span className="st-img__meta">
          <span>image {image ? imageName(image) : "removed"}</span>
          {created ? <span>created {created} ago</span> : null}
        </span>
      </div>
      <span className="st-img__tag">{c.removable ? <Tag tone="warn">{c.state === "created" ? "Never started" : "Stopped"}</Tag> : <Tag tone="good">Running</Tag>}</span>
    </li>
  );
}

interface DockerTabProps {
  spark: SparkSnapshot;
  /** Other online Sparks: their copies of the images being removed can be cleaned up in the same step. */
  peers?: SparkSnapshot[];
  access: AdminAccess;
  onNotice: (notice: Notice | null) => void;
  /** Disk numbers above the tabs are out of date after images are removed. */
  onDiskChanged: () => void;
}

/** Docker's share of the disk and its images: see them biggest first and remove the unused ones. */
export function DockerTab({ spark, peers = [], access, onNotice, onDiskChanged }: DockerTabProps) {
  const [data, setData] = useState<DockerStorage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<{ code?: string; message: string } | null>(null);
  const [asAdmin, setAsAdmin] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [selectedC, setSelectedC] = useState<ReadonlySet<string>>(new Set());
  const [containerFilter, setContainerFilter] = useState<"stopped" | "all">("stopped");
  /** The containers to remove, and whether the dialog starts with "also remove the image" ticked. */
  const [containerDialog, setContainerDialog] = useState<{ ids: string[]; alsoImages: boolean } | null>(null);
  const generation = useRef(0);

  const load = useCallback(
    async (admin: boolean) => {
      const mine = ++generation.current;
      setLoading(true);
      setError(null);
      try {
        const next = await fetchDockerStorage(spark.id, access.elevation(admin));
        if (mine !== generation.current) return;
        setData(next);
        setSelected((prev) => new Set([...prev].filter((id) => next.images.some((i) => i.id === id && i.status === "unused"))));
        // A password typed for this read may have been remembered: let the page re-read what it knows.
        if (admin && access.password) onDiskChanged();
        setSelectedC((prev) => new Set([...prev].filter((id) => (next.containers ?? []).some((c) => c.id === id && c.removable))));
        setLoading(false);
      } catch (err) {
        if (mine !== generation.current) return;
        const code = err instanceof ApiError ? err.code : undefined;
        if (code === "docker-denied" && !admin && access.available) {
          setAsAdmin(true);
          // Passwordless sudo: just carry on with it. Otherwise the password box below asks.
          if (access.sudo !== "no") return void load(true);
        }
        if (code === "bad-password") access.forget();
        setError({ code, message: err instanceof Error ? err.message : "Could not read Docker" });
        setLoading(false);
      }
    },
    [spark.id, access]
  );

  useEffect(() => {
    void load(false);
    // Once per Spark: the parent keys this tab by Spark.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const images = data?.images ?? [];
  // What the Spark could not list stays unknown: no image counts as unused without the full container list.
  const containersUnknown = data?.listing != null && data.listing.containers !== "ok";
  const imagesUnknown = data?.listing != null && data.listing.images !== "ok";
  const unused = useMemo(() => images.filter((i) => i.status === "unused"), [images]);
  const builtHere = unused.filter(isBuiltHere).length;
  const reclaimable = data?.usage.images?.reclaimableBytes ?? null;
  const shown = useMemo(
    () => images.filter((i) => (filter === "all" ? true : filter === "unused" ? i.status === "unused" : i.status !== "unused")),
    [images, filter]
  );
  const chosen = useMemo(() => images.filter((i) => selected.has(i.id)), [images, selected]);
  const estimate = freeEstimate(chosen, unused, reclaimable);
  const allUnusedSelected = unused.length > 0 && unused.every((i) => selected.has(i.id));

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const toggleAllUnused = () => setSelected(allUnusedSelected ? new Set() : new Set(unused.map((i) => i.id)));

  const containers = useMemo(() => data?.containers ?? [], [data]);
  const stopped = useMemo(() => containers.filter((c) => c.removable), [containers]);
  const shownContainers = containerFilter === "stopped" ? stopped : containers;
  const imageById = useMemo(() => new Map(images.map((i) => [i.id, i])), [images]);
  const chosenContainers = useMemo(() => containers.filter((c) => selectedC.has(c.id)), [containers, selectedC]);
  const dialogContainers = useMemo(() => (containerDialog ? containers.filter((c) => containerDialog.ids.includes(c.id)) : []), [containers, containerDialog]);
  const dialogImages = useMemo(
    () => [...new Set(dialogContainers.map((c) => c.imageId))].map((id) => imageById.get(id)).filter((i): i is DockerImage => Boolean(i)),
    [dialogContainers, imageById]
  );
  const allStoppedSelected = stopped.length > 0 && stopped.every((c) => selectedC.has(c.id));
  const toggleContainer = (id: string) =>
    setSelectedC((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  /**
   * Remove the containers, then (if asked) the images they leave unused. The images are looked up again
   * after the containers are gone: only those that really became unused are removed, and the unit
   * re-checks each one. A failure of the image step is reported, not thrown: the containers are already gone.
   */
  const removeContainers = async (alsoImages: boolean) => {
    if (!containerDialog) return;
    const elevation = access.elevation(asAdmin);
    const targets = dialogContainers;
    const res = await removeDockerContainers(spark.id, { ids: targets.map((c) => c.id), ...elevation });
    const parts: string[] = [];
    let tone: Notice["tone"] = res.removed.length > 0 ? "ok" : "info";
    if (res.removed.length > 0) parts.push(`Removed ${res.removed.length} container${res.removed.length === 1 ? "" : "s"}.`);
    if (res.skipped.length > 0) parts.push(`${res.skipped.length} skipped (running again or already gone).`);
    if (res.failed.length > 0) {
      parts.push(`${res.failed.length} could not be removed: ${res.failed[0].message || "Docker refused"}.`);
      tone = "warn";
    }
    if (alsoImages && res.removed.length > 0) {
      try {
        const removedImageIds = new Set(targets.filter((c) => res.removed.includes(c.id)).map((c) => c.imageId));
        const fresh = await fetchDockerStorage(spark.id, elevation);
        const free = fresh.images.filter((i) => removedImageIds.has(i.id) && i.status === "unused").map((i) => i.id);
        if (free.length > 0) {
          const imgRes = await removeDockerImages(spark.id, { ids: free, ...elevation });
          if (imgRes.removed.length > 0) parts.push(`Removed ${imgRes.removed.length} image${imgRes.removed.length === 1 ? "" : "s"}.`);
          if (imgRes.failed.length > 0) {
            parts.push(`${imgRes.failed.length} image${imgRes.failed.length === 1 ? "" : "s"} could not be removed: ${imgRes.failed[0].message || "Docker refused"}.`);
            tone = "warn";
          }
        } else {
          parts.push("The images are still used by other containers, so they were kept.");
        }
      } catch (err) {
        parts.push(`The containers are gone, but the images could not be removed: ${err instanceof Error ? err.message : "Docker refused"}.`);
        tone = "warn";
      }
    }
    setContainerDialog(null);
    setSelectedC(new Set());
    onNotice({ tone, text: parts.join(" ") || "Nothing was removed." });
    void load(asAdmin);
    onDiskChanged();
  };

  const onDone = (result: DockerRemoveResult, peerOutcomes: PeerOutcome[] = []) => {
    setConfirming(false);
    setSelected(new Set());
    const parts: string[] = [];
    if (result.removed.length > 0) parts.push(`Removed ${result.removed.length} image${result.removed.length === 1 ? "" : "s"}.`);
    if (result.skipped.length > 0) parts.push(`${result.skipped.length} skipped because a container started using ${result.skipped.length === 1 ? "it" : "them"}.`);
    if (result.failed.length > 0) parts.push(`${result.failed.length} could not be removed: ${result.failed[0].message || "Docker refused"}.`);
    for (const o of peerOutcomes) parts.push(o.text);
    const failed = result.failed.length > 0 || peerOutcomes.some((o) => o.failed);
    onNotice({ tone: failed ? "warn" : result.removed.length > 0 ? "ok" : "info", text: parts.join(" ") || "Nothing was removed." });
    void load(asAdmin);
    onDiskChanged();
  };

  // ─── Screens ───
  if (loading && !data) {
    return (
      <section className="panel st-state" role="status" aria-live="polite">
        <h2>Reading Docker on {spark.name}…</h2>
        <p>Docker measures its images and layers, which can take a few seconds.</p>
      </section>
    );
  }

  if (error && !data) {
    const needsAdmin = error.code === "docker-denied" || error.code === "no-sudo" || error.code === "bad-password";
    return (
      <section className="panel st-state" role="alert">
        <h2>{error.code === "no-docker" ? "Docker is not installed here" : needsAdmin ? "Docker needs administrator access" : "Could not read Docker"}</h2>
        <p>{error.message}</p>
        {needsAdmin ? (
          <div className="st-state__admin">
            <AdminFields access={access} purpose="to run Docker as administrator" onSubmit={() => void load(true)} problem={null} />
          </div>
        ) : null}
        {error.code === "no-docker" ? null : (
          <button type="button" className="btn btn--primary btn--sm" onClick={() => void load(needsAdmin)} disabled={needsAdmin && (!access.available || !access.ready)}>
            <RotateIcon className="h-3.5 w-3.5" />
            {needsAdmin ? "Unlock Docker" : "Try again"}
          </button>
        )}
      </section>
    );
  }
  if (!data) return null;

  return (
    <>
      <QuickCleanup
        spark={spark}
        data={data}
        peers={peers}
        access={access}
        asAdmin={asAdmin}
        onChanged={() => {
          void load(asAdmin);
          onDiskChanged();
        }}
      />

      <section className="st-tiles" aria-label="Docker disk use">
        {TILES.map((t) => {
          const row = data.usage[t.key];
          return row ? <Tile key={t.key} label={t.label} noun={t.noun} hint={t.hint} row={row} /> : null;
        })}
        {data.rootDir ? (
          <p className="st-tiles__root">
            Docker keeps all of this in <span className="mono">{data.rootDir}</span>. It shows up there on the Files tab when you
            analyse with administrator access.
          </p>
        ) : null}
      </section>

      <section className="panel st-images" aria-label="Docker images">
        <header className="st-images__head">
          <div>
            <h2>
              <BoxIcon className="h-4 w-4" /> Images
            </h2>
            <p>
              {unused.length > 0 ? (
                <>
                  <b>{unused.length} unused</b> image{unused.length === 1 ? "" : "s"}: no container uses {unused.length === 1 ? "it" : "them"}
                  {reclaimable ? (
                    <>
                      , and Docker estimates that removing {unused.length === 1 ? "it" : "all of them"} frees about <b>{formatBytes(reclaimable)}</b>
                    </>
                  ) : null}
                  . Review before removing: a pulled image can only be pulled again while its registry still has it
                  {builtHere > 0 ? (
                    <>
                      , and {builtHere === 1 ? "one was" : `${builtHere} were`} <b>built here, not pulled</b>, so {builtHere === 1 ? "it" : "they"} may be the
                      only copy
                    </>
                  ) : null}
                  .
                </>
              ) : containersUnknown ? (
                "Which containers use these images could not be checked, so none of them can be removed right now."
              ) : (
                "Every image is used by a container. Nothing to clean up here."
              )}
            </p>
          </div>
          <div className="st-images__tools">
            {asAdmin ? (
              <Tag tone="info" title="Docker commands run through sudo on this Spark">
                <ShieldIcon className="h-3 w-3" /> Administrator
              </Tag>
            ) : null}
            <button type="button" className="btn btn--sm btn--ghost" onClick={() => void load(asAdmin)} disabled={loading}>
              <RotateIcon className="h-3.5 w-3.5" />
              {loading ? "Reading…" : "Refresh"}
            </button>
          </div>
        </header>

        {error ? <Banner tone="warn">Could not refresh: {error.message}</Banner> : null}
        {containersUnknown || imagesUnknown ? (
          <Banner tone="warn">
            {containersUnknown ? "Docker did not list its containers, so whether an image is in use is unknown and nothing is offered for removal. " : ""}
            {imagesUnknown ? "Some images could not be read, so this list may be incomplete. " : ""}
            Refresh to try again.
          </Banner>
        ) : null}

        <div className="st-toolbar">
          <div className="seg" role="group" aria-label="Show images">
            <button type="button" aria-pressed={filter === "all"} onClick={() => setFilter("all")}>
              All {images.length}
            </button>
            <button type="button" aria-pressed={filter === "unused"} onClick={() => setFilter("unused")}>
              Unused {unused.length}
            </button>
            <button type="button" aria-pressed={filter === "used"} onClick={() => setFilter("used")}>
              In use {images.length - unused.length}
            </button>
          </div>
          {unused.length > 0 ? (
            <button type="button" className="btn btn--sm" onClick={toggleAllUnused}>
              {allUnusedSelected ? "Clear selection" : `Select all ${unused.length} unused`}
            </button>
          ) : null}
        </div>

        {shown.length === 0 ? (
          <div className="st-empty">
            <p>{images.length === 0 ? (imagesUnknown ? "The images could not be listed." : "There are no images on this Spark.") : "No images in this view."}</p>
          </div>
        ) : (
          <ul className="st-imgs">
            {shown.map((img) => {
              const removable = img.status === "unused";
              const extra = img.tags.length - 1;
              const created = img.created ? formatSince(Date.parse(img.created)) : null;
              return (
                <li key={img.id} className={`st-img${selected.has(img.id) ? " is-selected" : ""}${removable ? "" : " is-locked"}`}>
                  <label className="st-img__hit">
                    <input
                      type="checkbox"
                      className="st-img__check"
                      checked={selected.has(img.id)}
                      disabled={!removable}
                      onChange={() => toggle(img.id)}
                      aria-label={`Select ${imageName(img)}`}
                      title={removable ? undefined : `${usedByText(img)}. Remove ${img.usedBy.length === 1 ? "the container" : "the containers"} first (button on the right).`}
                    />
                  </label>
                  <div className="st-img__main">
                    <span className="st-img__name" title={img.tags.join("\n") || img.id}>
                      {imageName(img)}
                      {extra > 0 ? <span className="st-img__more"> +{extra}</span> : null}
                    </span>
                    <span className="st-img__meta">
                      <span className="mono">{shortId(img.id)}</span>
                      {img.registryDigest === false ? <BuiltHereTag /> : null}
                      {created ? <span>created {created} ago</span> : null}
                      {img.usedBy.length > 0 ? <span>{usedByText(img)}</span> : null}
                      {img.status === "stopped" ? (
                        <button
                          type="button"
                          className="st-link"
                          onClick={() =>
                            setContainerDialog({ ids: containers.filter((c) => c.imageId === img.id && c.removable).map((c) => c.id), alsoImages: true })
                          }
                        >
                          Remove {img.usedBy.length === 1 ? "container" : "containers"}…
                        </button>
                      ) : null}
                    </span>
                  </div>
                  <span className="st-img__tag">{statusTag(img)}</span>
                  <span className="st-img__size mono">{formatBytes(img.sizeBytes)}</span>
                </li>
              );
            })}
          </ul>
        )}

        <p className="st-hint st-images__foot">
          Sizes use 1 GB = 1024 MB like the rest of sparkDash, so they read about 7% lower than the Docker command line, which
          counts in thousands. Images share layers, so the sizes listed overlap: they add up to far more than the space the images really use.
        </p>
      </section>

      {containers.length > 0 ? (
        <section className="panel st-images" aria-label="Docker containers">
          <header className="st-images__head">
            <div>
              <h2>
                <BoxIcon className="h-4 w-4" /> Containers
              </h2>
              <p>
                {stopped.length > 0 ? (
                  <>
                    <b>{stopped.length} stopped</b> container{stopped.length === 1 ? "" : "s"}. They keep their image on disk, which is why
                    that image cannot be removed. Removing a container keeps its volumes but deletes its writable layer, which may hold data you
                    can&rsquo;t re-create.
                  </>
                ) : (
                  "Every container is running. Nothing to clean up here."
                )}
              </p>
            </div>
          </header>
          <div className="st-toolbar">
            <div className="seg" role="group" aria-label="Show containers">
              <button type="button" aria-pressed={containerFilter === "stopped"} onClick={() => setContainerFilter("stopped")}>
                Stopped {stopped.length}
              </button>
              <button type="button" aria-pressed={containerFilter === "all"} onClick={() => setContainerFilter("all")}>
                All {containers.length}
              </button>
            </div>
            <div className="st-toolbar__group">
              {stopped.length > 0 ? (
                <button type="button" className="btn btn--sm" onClick={() => setSelectedC(allStoppedSelected ? new Set() : new Set(stopped.map((c) => c.id)))}>
                  {allStoppedSelected ? "Clear selection" : `Select all ${stopped.length} stopped`}
                </button>
              ) : null}
              {chosenContainers.length > 0 ? (
                <button type="button" className="btn btn--sm btn--danger" onClick={() => setContainerDialog({ ids: chosenContainers.map((c) => c.id), alsoImages: false })}>
                  <TrashIcon className="h-3.5 w-3.5" />
                  Remove {chosenContainers.length === 1 ? "container" : `${chosenContainers.length} containers`}
                </button>
              ) : null}
            </div>
          </div>
          {shownContainers.length === 0 ? (
            <div className="st-empty">
              <p>No containers in this view.</p>
            </div>
          ) : (
            <ul className="st-imgs">
              {shownContainers.map((c) => (
                <ContainerRow key={c.id} container={c} image={imageById.get(c.imageId)} selected={selectedC.has(c.id)} onToggle={toggleContainer} />
              ))}
            </ul>
          )}
        </section>
      ) : null}

      {chosen.length > 0 ? (
        <div className="st-actionbar" role="region" aria-label="Selected images">
          <span>
            <b>{chosen.length}</b> selected · frees {estimate}
          </span>
          <button type="button" className="btn btn--sm btn--ghost" onClick={() => setSelected(new Set())}>
            Clear
          </button>
          <button type="button" className="btn btn--danger" onClick={() => setConfirming(true)}>
            <TrashIcon className="h-3.5 w-3.5" />
            Remove {chosen.length === 1 ? "image" : `${chosen.length} images`}
          </button>
        </div>
      ) : null}

      <RemoveContainersDialog
        containers={dialogContainers}
        images={dialogImages}
        alsoImagesDefault={containerDialog?.alsoImages ?? false}
        asAdmin={asAdmin}
        access={access}
        onConfirm={removeContainers}
        onClose={() => setContainerDialog(null)}
      />
      <RemoveImagesDialog
        sparkId={spark.id}
        peers={peers}
        images={confirming ? chosen : []}
        estimate={estimate}
        asAdmin={asAdmin}
        access={access}
        onClose={() => setConfirming(false)}
        onDone={onDone}
      />
    </>
  );
}
