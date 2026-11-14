import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
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

function Tile({ label, detail, hint, row }: { label: string; detail: string; hint: string; row?: DockerUsageRow }) {
  const { t } = useTranslation("storage");
  if (!row) return null;
  return (
    <div className="st-tile" title={hint}>
      <span className="st-tile__label">{label}</span>
      <span className="st-tile__size mono">{formatBytes(row.sizeBytes)}</span>
      <span className="st-tile__sub">
        {detail}
        {row.reclaimableBytes ? <> · {t("docker.reclaimable", { size: formatBytes(row.reclaimableBytes) })}</> : null}
      </span>
    </div>
  );
}

function statusTag(img: DockerImage, t: TFunction<"storage">) {
  if (img.status === "running") return <Tag tone="good">{t("docker.imageInUse")}</Tag>;
  if (img.status === "stopped") return <Tag tone="warn">{t("docker.imageStopped")}</Tag>;
  // The Spark could not list its containers: never offered for removal.
  if (img.status === "unknown") return <Tag tone="warn">{t("docker.imageUsageUnknown")}</Tag>;
  return <Tag tone="acc">{t("docker.imageUnused")}</Tag>;
}

/**
 * What removing images frees. Image sizes overlap (they share layers), so adding them up overstates it a lot.
 * Docker's own "reclaimable" figure counts shared layers once; it is only valid for removing every unused image.
 */
function freeEstimate(chosen: DockerImage[], unused: DockerImage[], reclaimableBytes: number | null | undefined, t: TFunction<"storage">): string {
  const combined = chosen.reduce((sum, i) => sum + (i.sizeBytes ?? 0), 0);
  const everyUnused = chosen.length > 0 && chosen.length === unused.length;
  if (everyUnused && reclaimableBytes != null) return t("docker.estimatedSpace", { size: formatBytes(reclaimableBytes) });
  return t("docker.sharedSpace", { size: formatBytes(combined) });
}

function usedByText(img: DockerImage, t: TFunction<"storage">): string {
  const names = img.usedBy.slice(0, 3).map((c) => c.name);
  const more = img.usedBy.length - names.length;
  return more > 0 ? t("docker.usedByMore", { names: names.join(", "), count: more }) : t("docker.usedBy", { names: names.join(", ") });
}

function ContainerRow({ container: c, image, selected, onToggle }: { container: DockerContainer; image: DockerImage | undefined; selected: boolean; onToggle: (id: string) => void }) {
  const { t } = useTranslation("storage");
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
          aria-label={t("docker.selectContainer", { name: c.name })}
          title={c.removable ? undefined : t("docker.stopBeforeRemove")}
        />
      </label>
      <div className="st-img__main">
        <span className="st-img__name">{c.name}</span>
        <span className="st-img__meta">
          <span>{image ? t("docker.containerImage", { image: imageName(image, t) }) : t("docker.containerImageRemoved")}</span>
          {created ? <span>{t("docker.createdAgo", { age: created })}</span> : null}
        </span>
      </div>
      <span className="st-img__tag">{c.removable ? <Tag tone="warn">{c.state === "created" ? t("docker.neverStarted") : t("docker.containerStopped")}</Tag> : <Tag tone="good">{t("docker.containerRunning")}</Tag>}</span>
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
  const { t } = useTranslation("storage");
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
        setError({ code, message: err instanceof Error ? err.message : t("docker.couldNotRead") });
        setLoading(false);
      }
    },
    [spark.id, access, t]
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
  const estimate = freeEstimate(chosen, unused, reclaimable, t);
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
    if (res.removed.length > 0) parts.push(t("docker.containersRemoved", { count: res.removed.length }));
    if (res.skipped.length > 0) parts.push(t("docker.containersSkipped", { count: res.skipped.length }));
    if (res.failed.length > 0) {
      parts.push(t("docker.removalFailed", { count: res.failed.length, error: res.failed[0].message || t("docker.refused") }));
      tone = "warn";
    }
    if (alsoImages && res.removed.length > 0) {
      try {
        const removedImageIds = new Set(targets.filter((c) => res.removed.includes(c.id)).map((c) => c.imageId));
        const fresh = await fetchDockerStorage(spark.id, elevation);
        const free = fresh.images.filter((i) => removedImageIds.has(i.id) && i.status === "unused").map((i) => i.id);
        if (free.length > 0) {
          const imgRes = await removeDockerImages(spark.id, { ids: free, ...elevation });
          if (imgRes.removed.length > 0) parts.push(t("docker.imagesRemoved", { count: imgRes.removed.length }));
          if (imgRes.failed.length > 0) {
            parts.push(t("docker.imagesRemovalFailed", { count: imgRes.failed.length, error: imgRes.failed[0].message || t("docker.refused") }));
            tone = "warn";
          }
        } else {
          parts.push(t("docker.imagesKept"));
        }
      } catch (err) {
        parts.push(t("docker.containersRemovedImagesFailed", { error: err instanceof Error ? err.message : t("docker.refused") }));
        tone = "warn";
      }
    }
    setContainerDialog(null);
    setSelectedC(new Set());
    onNotice({ tone, text: parts.join(" ") || t("docker.nothingRemoved") });
    void load(asAdmin);
    onDiskChanged();
  };

  const onDone = (result: DockerRemoveResult, peerOutcomes: PeerOutcome[] = []) => {
    setConfirming(false);
    setSelected(new Set());
    const parts: string[] = [];
    if (result.removed.length > 0) parts.push(t("docker.imagesRemoved", { count: result.removed.length }));
    if (result.skipped.length > 0) parts.push(t("docker.imagesSkipped", { count: result.skipped.length }));
    if (result.failed.length > 0) parts.push(t("docker.removalFailed", { count: result.failed.length, error: result.failed[0].message || t("docker.refused") }));
    for (const o of peerOutcomes) parts.push(o.text);
    const failed = result.failed.length > 0 || peerOutcomes.some((o) => o.failed);
    onNotice({ tone: failed ? "warn" : result.removed.length > 0 ? "ok" : "info", text: parts.join(" ") || t("docker.nothingRemoved") });
    void load(asAdmin);
    onDiskChanged();
  };

  // ─── Screens ───
  if (loading && !data) {
    return (
      <section className="panel st-state" role="status" aria-live="polite">
        <h2>{t("docker.reading", { spark: spark.name })}</h2>
        <p>{t("docker.readingHint", { })}</p>
      </section>
    );
  }

  if (error && !data) {
    const needsAdmin = error.code === "docker-denied" || error.code === "no-sudo" || error.code === "bad-password";
    return (
      <section className="panel st-state" role="alert">
        <h2>{error.code === "no-docker" ? t("docker.notInstalled", { }) : needsAdmin ? t("docker.needsAdmin", { }) : t("docker.couldNotRead", { })}</h2>
        <p>{error.message}</p>
        {needsAdmin ? (
          <div className="st-state__admin">
            <AdminFields access={access} purpose={t("docker.adminPurpose")} onSubmit={() => void load(true)} problem={null} />
          </div>
        ) : null}
        {error.code === "no-docker" ? null : (
          <button type="button" className="btn btn--primary btn--sm" onClick={() => void load(needsAdmin)} disabled={needsAdmin && (!access.available || !access.ready)}>
            <RotateIcon className="h-3.5 w-3.5" />
            {needsAdmin ? t("docker.unlock", { }) : t("docker.tryAgain", { })}
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

      <section className="st-tiles" aria-label={t("docker.diskUse", { })}>
        <Tile label={t("docker.images")} detail={t("docker.imageCount", { amount: data.usage.images?.count ?? "?" })}
          hint={t("docker.imagesHint")} row={data.usage.images} />
        <Tile label={t("docker.containers")} detail={t("docker.containerCount", { amount: data.usage.containers?.count ?? "?" })}
          hint={t("docker.containersHint")} row={data.usage.containers} />
        <Tile label={t("docker.volumes")} detail={t("docker.volumeCount", { amount: data.usage.volumes?.count ?? "?" })}
          hint={t("docker.volumesHint")} row={data.usage.volumes} />
        <Tile label={t("docker.buildCache")} detail={t("docker.cacheCount", { amount: data.usage.buildCache?.count ?? "?" })}
          hint={t("docker.buildCacheHint")} row={data.usage.buildCache} />
        {data.rootDir ? (
          <p className="st-tiles__root">
            {t("docker.rootNote", { path: data.rootDir })}
          </p>
        ) : null}
      </section>

      <section className="panel st-images" aria-label={t("docker.imagesAria", { })}>
        <header className="st-images__head">
          <div>
            <h2>
              <BoxIcon className="h-4 w-4" /> {t("docker.images", { })}
            </h2>
            <p>
              {unused.length > 0 ? (
                <>
                  {t("docker.unusedSummary", { count: unused.length })}{" "}
                  {reclaimable ? <>{t("docker.reclaimSummary", { size: formatBytes(reclaimable) })}{" "}</> : null}
                  {t("docker.reviewBeforeRemove")}
                  {builtHere > 0 ? <>{" "}{t("docker.builtSummary", { count: builtHere })}</> : null}
                </>
              ) : containersUnknown ? (
                t("docker.noRemovalUnknown", { })
              ) : (
                t("docker.noUnused", { })
              )}
            </p>
          </div>
          <div className="st-images__tools">
            {asAdmin ? (
              <Tag tone="info" title={t("docker.adminTitle", { })}>
                <ShieldIcon className="h-3 w-3" /> {t("docker.administrator", { })}
              </Tag>
            ) : null}
            <button type="button" className="btn btn--sm btn--ghost" onClick={() => void load(asAdmin)} disabled={loading}>
              <RotateIcon className="h-3.5 w-3.5" />
              {loading ? t("docker.readingShort", { }) : t("docker.refresh", { })}
            </button>
          </div>
        </header>

        {error ? <Banner tone="warn">{t("docker.refreshFailed", { message: error.message })}</Banner> : null}
        {containersUnknown || imagesUnknown ? (
          <Banner tone="warn">
            {containersUnknown ? t("docker.containersUnknown", { }) : ""}
            {imagesUnknown ? t("docker.imagesUnknown", { }) : ""}
            {t("docker.refreshTryAgain", { })}
          </Banner>
        ) : null}

        <div className="st-toolbar">
          <div className="seg" role="group" aria-label={t("docker.showImages", { })}>
            <button type="button" aria-pressed={filter === "all"} onClick={() => setFilter("all")}>
              {t("docker.all", { count: images.length })}
            </button>
            <button type="button" aria-pressed={filter === "unused"} onClick={() => setFilter("unused")}>
              {t("docker.unused", { count: unused.length })}
            </button>
            <button type="button" aria-pressed={filter === "used"} onClick={() => setFilter("used")}>
              {t("docker.inUse", { count: images.length - unused.length })}
            </button>
          </div>
          {unused.length > 0 ? (
            <button type="button" className="btn btn--sm" onClick={toggleAllUnused}>
              {allUnusedSelected ? t("docker.clearSelection", { }) : t("docker.selectAllUnused", { count: unused.length })}
            </button>
          ) : null}
        </div>

        {shown.length === 0 ? (
          <div className="st-empty">
            <p>{images.length === 0 ? (imagesUnknown ? t("docker.imagesUnlisted", { }) : t("docker.noImages", { })) : t("docker.noImagesView", { })}</p>
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
                      aria-label={t("docker.selectImage", { image: imageName(img, t) })}
                      title={removable ? undefined : t("docker.usedImageTitle", { usedBy: usedByText(img, t), count: img.usedBy.length })}
                    />
                  </label>
                  <div className="st-img__main">
                    <span className="st-img__name" title={img.tags.join("\n") || img.id}>
                      {imageName(img, t)}
                      {extra > 0 ? <span className="st-img__more"> +{extra}</span> : null}
                    </span>
                    <span className="st-img__meta">
                      <span className="mono">{shortId(img.id)}</span>
                      {img.registryDigest === false ? <BuiltHereTag /> : null}
                      {created ? <span>{t("docker.createdAgo", { age: created })}</span> : null}
                      {img.usedBy.length > 0 ? <span>{usedByText(img, t)}</span> : null}
                      {img.status === "stopped" ? (
                        <button
                          type="button"
                          className="st-link"
                          onClick={() =>
                            setContainerDialog({ ids: containers.filter((c) => c.imageId === img.id && c.removable).map((c) => c.id), alsoImages: true })
                          }
                        >
                          {t("docker.removeImageContainers", { count: img.usedBy.length })}
                        </button>
                      ) : null}
                    </span>
                  </div>
                  <span className="st-img__tag">{statusTag(img, t)}</span>
                  <span className="st-img__size mono">{formatBytes(img.sizeBytes)}</span>
                </li>
              );
            })}
          </ul>
        )}

        <p className="st-hint st-images__foot">
          {t("docker.sizeFootnote", { })}
        </p>
      </section>

      {containers.length > 0 ? (
        <section className="panel st-images" aria-label={t("docker.containersAria", { })}>
          <header className="st-images__head">
            <div>
              <h2>
                <BoxIcon className="h-4 w-4" /> {t("docker.containers", { })}
              </h2>
              <p>
                {stopped.length > 0 ? (
                  <>
                    {t("docker.stoppedSummary", { count: stopped.length })}
                  </>
                ) : (
                  t("docker.noStopped", { })
                )}
              </p>
            </div>
          </header>
          <div className="st-toolbar">
            <div className="seg" role="group" aria-label={t("docker.showContainers", { })}>
              <button type="button" aria-pressed={containerFilter === "stopped"} onClick={() => setContainerFilter("stopped")}>
                {t("docker.stopped", { count: stopped.length })}
              </button>
              <button type="button" aria-pressed={containerFilter === "all"} onClick={() => setContainerFilter("all")}>
                {t("docker.all", { count: containers.length })}
              </button>
            </div>
            <div className="st-toolbar__group">
              {stopped.length > 0 ? (
                <button type="button" className="btn btn--sm" onClick={() => setSelectedC(allStoppedSelected ? new Set() : new Set(stopped.map((c) => c.id)))}>
                  {allStoppedSelected ? t("docker.clearSelection", { }) : t("docker.selectAllStopped", { count: stopped.length })}
                </button>
              ) : null}
              {chosenContainers.length > 0 ? (
                <button type="button" className="btn btn--sm btn--danger" onClick={() => setContainerDialog({ ids: chosenContainers.map((c) => c.id), alsoImages: false })}>
                  <TrashIcon className="h-3.5 w-3.5" />
                  {t("docker.removeContainers", { count: chosenContainers.length })}
                </button>
              ) : null}
            </div>
          </div>
          {shownContainers.length === 0 ? (
            <div className="st-empty">
              <p>{t("docker.noContainersView", { })}</p>
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
        <div className="st-actionbar" role="region" aria-label={t("docker.selectedImages", { })}>
          <span>
            {t("docker.selectedEstimate", { count: chosen.length, estimate })}
          </span>
          <button type="button" className="btn btn--sm btn--ghost" onClick={() => setSelected(new Set())}>
            {t("docker.clear", { })}
          </button>
          <button type="button" className="btn btn--danger" onClick={() => setConfirming(true)}>
            <TrashIcon className="h-3.5 w-3.5" />
            {t("docker.removeImages", { count: chosen.length })}
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
