import { useEffect, useId, useMemo, useRef, useState } from "react";
import { ApiError, fetchStorageStatus, pruneDockerBuilderCache, removeDockerContainers, removeDockerImages } from "../../api/client";
import type { DockerRemoveResult, DockerStorage, SparkSnapshot, StorageElevation, StorageStatus } from "../../api/types";
import { formatBytes } from "../../shared/formatBytes";
import { formatSince } from "../../shared/formatSince";
import { AlertTriangleIcon, BoxIcon, TrashIcon } from "../ui/icons";
import { Tag } from "../ui/Tag";
import { AdminFields } from "./AdminFields";
import { PeersBlock, toggled, usePeerDockerLists, type PeerDockerList, type PeerRowView } from "./dockerPeers";
import { BUILT_HERE_TITLE, isBuiltHere } from "./dockerProvenance";
import {
  actionLabel,
  buildCacheEmpty,
  buildCacheEstimate,
  containersEstimate,
  countText,
  dockerFilesystem,
  estimateText,
  imagesEstimate,
  parseDockerTime,
  pickContainers,
  pickImages,
  planFor,
  presetClass,
  presetKind,
  presetTitle,
  shortEstimate,
  spaceChangeText,
  usageUnknownReason,
  type QuickDays,
  type QuickOutcome,
  type QuickPlan,
  type QuickPresetId,
  type QuickRule,
  type SizeEstimate,
  type SparkRun,
} from "./dockerQuick";
import { imageName, shortId } from "./RemoveImagesDialog";
import { StorageDialog } from "./StorageDialog";
import type { AdminAccess } from "./useAdminAccess";

interface QuickCleanupSheetProps {
  /** The presets the sheet offers; null when closed. Those with something to clean start ticked. */
  presets: readonly QuickPresetId[] | null;
  spark: SparkSnapshot;
  data: DockerStorage;
  days: QuickDays;
  /** The clock the card used, so the sheet shows exactly what the card counted. */
  now: number;
  /** Other online Sparks: the same rule can run on each of them too. */
  peers: SparkSnapshot[];
  /** Docker on this Spark was read through sudo, so changes go the same way (the same daemon). */
  asAdmin: boolean;
  access: AdminAccess;
  onClose: () => void;
  onDone: (outcome: QuickOutcome) => void;
}

/** Most IDs one removal request takes (the server's limit). */
const CHUNK = 200;
const STATUS_WAIT_MS = 10_000;

interface Category {
  id: QuickPresetId;
  kind: ReturnType<typeof presetKind>;
  images: DockerStorage["images"];
  containers: NonNullable<DockerStorage["containers"]>;
  estimate: SizeEstimate;
  /** Nothing to clean, with the reason; null when there is something. */
  blocked: string | null;
}

function categoryOf(id: QuickPresetId, data: DockerStorage, rule: QuickRule): Category {
  const kind = presetKind(id);
  const unknown = kind === "build-cache" ? null : usageUnknownReason(data);
  if (kind === "images") {
    const items = pickImages(data, id, rule).items;
    return { id, kind, images: items, containers: [], estimate: imagesEstimate(items, data), blocked: unknown ?? (items.length === 0 ? "Nothing to clean" : null) };
  }
  if (kind === "containers") {
    const items = pickContainers(data, rule);
    return { id, kind, images: [], containers: items, estimate: containersEstimate(items, data), blocked: unknown ?? (items.length === 0 ? "Nothing to clean" : null) };
  }
  return { id, kind, images: [], containers: [], estimate: buildCacheEstimate(data), blocked: buildCacheEmpty(data) ? "Nothing to clean" : null };
}

/** "4 images · up to 12 GB (images share layers)": the one-line figure of a category. */
function categoryFigure(c: Category): string {
  if (c.blocked) return c.blocked;
  if (c.kind === "build-cache") return `Unused build cache · ${estimateText(c.estimate, c.kind)}`;
  const n = c.kind === "images" ? countText(c.images.length, "image") : countText(c.containers.length, "container");
  return `${n} · ${estimateText(c.estimate, c.kind)}`;
}

/** Status of the Spark's disks, or null when it does not answer in time (the space line is then left out). */
async function statusOrNull(sparkId: string): Promise<StorageStatus | null> {
  try {
    return await Promise.race([fetchStorageStatus(sparkId), new Promise<null>((r) => setTimeout(() => r(null), STATUS_WAIT_MS))]);
  } catch {
    return null;
  }
}

type RemoveFn = (id: string, body: StorageElevation & { ids: string[] }) => Promise<DockerRemoveResult>;

/** Remove IDs in requests the server accepts. A request failing after others went through marks the rest failed. */
async function removeAll(fn: RemoveFn, sparkId: string, ids: string[], elevation: StorageElevation): Promise<DockerRemoveResult> {
  const out: DockerRemoveResult = { success: true, removed: [], skipped: [], failed: [] };
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    try {
      const r = await fn(sparkId, { ids: chunk, ...elevation });
      out.removed.push(...r.removed);
      out.skipped.push(...r.skipped);
      out.failed.push(...r.failed);
    } catch (err) {
      if (i === 0) throw err;
      const message = err instanceof Error ? err.message : "Docker refused";
      out.failed.push(...ids.slice(i).map((id) => ({ id, message })));
      break;
    }
  }
  return out;
}

const messageOf = (err: unknown) => (err instanceof Error ? err.message : "Docker refused the request");

/**
 * Run a plan on one Spark: stopped containers, then images, then build cache, one after another. Each request is
 * independent; a failed one is recorded and the rest still run. With `firstFails` the first request failing is
 * thrown instead (nothing has changed yet, so the sheet can stay open with the reason).
 */
async function runPlan(
  target: { id: string; name: string },
  plan: QuickPlan,
  elevation: StorageElevation,
  days: number,
  firstFails: boolean,
  onStep: (text: string) => void
): Promise<SparkRun> {
  const run: SparkRun = { sparkId: target.id, name: target.name, images: null, containers: null, buildCache: null, errors: [], names: {} };
  for (const c of plan.containers) run.names[c.id] = c.name;
  // An untagged image is told apart by its short ID.
  for (const i of plan.images) run.names[i.id] = i.tags.length > 0 ? imageName(i) : `Untagged image ${shortId(i.id)}`;
  let first = firstFails;
  const step = async (kind: SparkRun["errors"][number]["step"], fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (err) {
      if (first) throw err;
      run.errors.push({ step: kind, message: messageOf(err) });
    }
    first = false;
  };
  if (plan.containers.length > 0) {
    onStep(`Removing ${countText(plan.containers.length, "container")} on ${target.name}…`);
    await step("containers", async () => {
      run.containers = await removeAll(removeDockerContainers, target.id, plan.containers.map((c) => c.id), elevation);
    });
  }
  if (plan.images.length > 0) {
    onStep(`Removing ${countText(plan.images.length, "image")} on ${target.name}…`);
    await step("images", async () => {
      run.images = await removeAll(removeDockerImages, target.id, plan.images.map((i) => i.id), elevation);
    });
  }
  if (plan.buildCache) {
    onStep(`Clearing build cache on ${target.name}…`);
    await step("build-cache", async () => {
      const r = await pruneDockerBuilderCache(target.id, { olderThanDays: days, ...elevation });
      run.buildCache = { reclaimedBytes: r.reclaimedBytes };
    });
  }
  return run;
}

/** Errors that a password or a moment's wait fixes: the sheet stays open and says so. */
const PASSWORD_CODES = new Set(["bad-password", "no-sudo"]);

/** One other Spark under the same rule: what it would remove there, as a fixed one-line row. */
function peerView(l: PeerDockerList, presets: readonly QuickPresetId[], rule: QuickRule): { view: PeerRowView; plan: QuickPlan | null } {
  const base = { id: l.spark.id, name: l.spark.name, title: "" };
  if (l.state === "loading" || (l.state === "ready" && !l.data)) return { view: { ...base, detail: "Checking…", selectable: false }, plan: null };
  if (l.state === "error" || !l.data) return { view: { ...base, detail: `Could not be checked: ${l.error ?? "no answer"}`, tone: "error", selectable: false }, plan: null };
  const unknown = usageUnknownReason(l.data);
  if (unknown) return { view: { ...base, detail: `${unknown} there.`, tone: "none", selectable: false }, plan: null };
  if (presets.length === 0) return { view: { ...base, detail: "Nothing ticked above applies to other Sparks.", tone: "none", selectable: false }, plan: null };
  const plan = planFor(l.data, presets, rule);
  const kept = plan.keptBuiltHere.length > 0 ? `${plan.keptBuiltHere.length} built there kept` : "";
  if (plan.images.length + plan.containers.length === 0) return { view: { ...base, detail: `Nothing to clean there with this rule${kept ? `; ${kept}` : ""}.`, tone: "none", selectable: false }, plan };
  // Most telling first, so a narrow screen that cuts the line still shows what goes and how much. The light list
  // has no container sizes, so the size is the images' only.
  const size = shortEstimate(imagesEstimate(plan.images, l.data));
  const images = plan.images.length > 0 ? `${countText(plan.images.length, "image")}${size ? ` (${size})` : ""}` : "";
  const containers = plan.containers.length > 0 ? countText(plan.containers.length, "container") : "";
  const detail = [`Removes ${[images, containers].filter(Boolean).join(" and ")}`, kept, l.elevate ? "as administrator" : ""].filter(Boolean).join(" · ");
  return { view: { ...base, detail, selectable: true }, plan };
}

/**
 * Confirm a quick clean-up. Every category can be unticked and opened to see exactly what goes; what is shown is
 * what is sent (explicit IDs), and the Spark checks each one again right before removing it. Images built on this
 * Spark are kept unless the person ticks them in. Other Sparks get the same rule on their own lists, only when ticked.
 */
export function QuickCleanupSheet({ presets, spark, data, days, now, peers: peerSparks, asAdmin, access, onClose, onDone }: QuickCleanupSheetProps) {
  const open = presets != null;
  // Keep the last categories on screen while the sheet fades out.
  const shownRef = useRef<readonly QuickPresetId[]>([]);
  if (presets) shownRef.current = presets;
  const shown = presets ?? shownRef.current;
  const shownKey = shown.join(",");
  const baseId = useId();

  const [ticked, setTicked] = useState<ReadonlySet<QuickPresetId>>(new Set());
  const [expanded, setExpanded] = useState<ReadonlySet<QuickPresetId>>(new Set());
  const [includeBuiltHere, setIncludeBuiltHere] = useState(false);
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [problem, setProblem] = useState<{ text: string; password: boolean } | null>(null);
  const problemRef = useRef<HTMLDivElement | null>(null);

  const rule = useMemo<QuickRule>(() => ({ days, now, includeBuiltHere }), [days, now, includeBuiltHere]);
  const categories = useMemo(() => shown.map((id) => categoryOf(id, data, rule)), [shown, data, rule]);
  // Images built here that the image categories match, counted before the person chooses to include them.
  const builtHere = useMemo(() => {
    const imagePresets = shown.filter((id) => presetKind(id) === "images");
    return imagePresets.length === 0 ? [] : planFor(data, imagePresets, { days, now, includeBuiltHere: false }).keptBuiltHere;
  }, [shown, data, days, now]);

  useEffect(() => {
    if (!presets) return;
    // What has something to clean starts ticked; nothing else, and never the built-here images or other Sparks.
    const start = presets.map((id) => categoryOf(id, data, { days, now, includeBuiltHere: false })).filter((c) => !c.blocked);
    setTicked(new Set(start.map((c) => c.id)));
    setExpanded(new Set());
    setIncludeBuiltHere(false);
    setPicked(new Set());
    setBusy(false);
    setProgress("");
    setProblem(null);
    // Only when the sheet opens, or opens for other categories.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, shownKey]);

  useEffect(() => {
    if (problem) problemRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [problem]);

  const active = useMemo(() => categories.filter((c) => ticked.has(c.id) && !c.blocked), [categories, ticked]);
  const plan = useMemo(() => planFor(data, active.map((c) => c.id), rule), [data, active, rule]);

  // Other Sparks: the image and container categories that are ticked, on each Spark's own list.
  const offersPeers = peerSparks.length > 0 && shown.some((id) => presetKind(id) !== "build-cache");
  const lists = usePeerDockerLists(open && offersPeers, peerSparks);
  const peerPresets = active.filter((c) => c.kind !== "build-cache").map((c) => c.id);
  const peerRows = lists.map((l) => peerView(l, peerPresets, rule));
  const pickedPeers = peerRows.filter((r) => r.view.selectable && picked.has(r.view.id) && r.plan);

  const hereRemoves = plan.images.length + plan.containers.length > 0;
  const sparksRemoving = (hereRemoves ? 1 : 0) + pickedPeers.length;
  const label = actionLabel({
    images: plan.images.length + pickedPeers.reduce((n, r) => n + (r.plan?.images.length ?? 0), 0),
    containers: plan.containers.length + pickedPeers.reduce((n, r) => n + (r.plan?.containers.length ?? 0), 0),
    buildCache: plan.buildCache,
    sparks: sparksRemoving,
    // One Spark removes anything: say which when other Sparks are on offer (and when it is not this one).
    where: sparksRemoving !== 1 ? undefined : !hereRemoves ? pickedPeers[0]?.view.name : offersPeers ? spark.name : undefined,
  });
  const nothing = !hereRemoves && !plan.buildCache && pickedPeers.length === 0;
  const adminReady = !asAdmin || (access.ready && access.available);
  const canRun = !busy && !nothing && adminReady;

  const run = async () => {
    if (!canRun) return;
    setBusy(true);
    setProblem(null);
    const runs: SparkRun[] = [];
    const figures: string[] = [];
    const imagesFigure = imagesEstimate(plan.images, data);
    const containersFigure = containersEstimate(plan.containers, data);
    const before = await statusOrNull(spark.id);
    try {
      runs.push(await runPlan({ id: spark.id, name: spark.name }, plan, access.elevation(asAdmin), days, true, setProgress));
    } catch (err) {
      // The first request on this Spark failed: nothing has changed. Stay open with the reason.
      setBusy(false);
      setProgress("");
      const code = err instanceof ApiError ? err.code : undefined;
      if (code === "bad-password") access.forget();
      setProblem({
        text: code === "bad-password" ? "The sudo password was not accepted. Check it and try again." : messageOf(err),
        password: code != null && PASSWORD_CODES.has(code) && asAdmin,
      });
      return;
    }
    // Then each ticked Spark in turn; one failing does not stop the others, and nothing is atomic across Sparks.
    for (const r of pickedPeers) {
      const l = lists.find((x) => x.spark.id === r.view.id);
      if (!l || !r.plan) continue;
      runs.push(await runPlan({ id: l.spark.id, name: l.spark.name }, { ...r.plan, buildCache: false }, l.elevate ? { sudo: true } : {}, days, false, setProgress));
    }
    const here = runs[0];
    if (here.images && imagesFigure.kind === "about") figures.push(`Docker estimated about ${formatBytes(imagesFigure.bytes)} reclaimable for the images.`);
    if (here.containers && containersFigure.kind === "about") figures.push(`Docker estimated about ${formatBytes(containersFigure.bytes)} reclaimable for the containers.`);
    if (here.buildCache?.reclaimedBytes != null) figures.push(`Docker reports ${formatBytes(here.buildCache.reclaimedBytes)} of build cache reclaimed.`);
    let space: string | null = null;
    if (before) {
      const after = await statusOrNull(spark.id);
      const fsBefore = dockerFilesystem(before.filesystems, data.rootDir);
      const fsAfter = fsBefore ? after?.filesystems.find((f) => f.mount === fsBefore.mount && f.source === fsBefore.source) : null;
      if (fsBefore && fsAfter) space = spaceChangeText(fsBefore, fsAfter);
    }
    setBusy(false);
    setProgress("");
    onDone({ runs, figures, space });
  };

  const toggleCategory = (id: QuickPresetId) => setTicked((prev) => toggled(prev, id));
  const toggleExpanded = (id: QuickPresetId) => setExpanded((prev) => toggled(prev, id));
  const title = shown.length === 1 ? "Quick clean-up" : "Recommended clean-up";

  return (
    <StorageDialog
      open={open}
      busy={busy}
      onClose={onClose}
      title={title}
      icon={<BoxIcon className="h-4 w-4 shrink-0" />}
      footer={
        <>
          <button type="button" className="btn btn--ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn--danger st-quick-go"
            onClick={() => void run()}
            disabled={!canRun}
            title={!adminReady && !busy && !nothing ? "Type the sudo password first" : undefined}
          >
            <TrashIcon className="h-3.5 w-3.5" />
            {busy ? "Working…" : label}
          </button>
        </>
      }
    >
      <p className="modal-sheet__lead">
        Only what is listed below goes from {spark.name}. The Spark checks each item again right before removing it and skips anything that changed.
        Running containers, volumes and your files are never touched.
      </p>

      <ul className="st-quick-cats" aria-label="What will be cleaned">
        {categories.map((c) => {
          const cls = presetClass(c.id);
          const figureId = `${baseId}-${c.id}-figure`;
          const listId = `${baseId}-${c.id}-list`;
          const count = c.kind === "images" ? c.images.length : c.containers.length;
          const isOpen = expanded.has(c.id) && count > 0;
          return (
            <li key={c.id} className={`st-quick-cat${c.blocked ? " is-empty" : ""}`}>
              <label className="check-row st-quick-cat__check">
                <input
                  type="checkbox"
                  checked={ticked.has(c.id) && !c.blocked}
                  disabled={busy || c.blocked != null}
                  onChange={() => toggleCategory(c.id)}
                  aria-describedby={figureId}
                />
                <span className="st-quick-cat__text">
                  <span className="st-quick-cat__title">
                    <Tag tone={cls.tone} className="st-class">
                      {cls.label}
                    </Tag>
                    {presetTitle(c.id, days)}
                  </span>
                  <small className="st-hint st-quick-cat__figure" id={figureId}>
                    {categoryFigure(c)}
                  </small>
                </span>
              </label>
              {c.kind !== "build-cache" && count > 0 ? (
                <button type="button" className="st-link st-quick-cat__more" aria-expanded={isOpen} aria-controls={listId} onClick={() => toggleExpanded(c.id)}>
                  {isOpen ? "Hide the list" : `Show the ${countText(count, c.kind === "images" ? "image" : "container")}`}
                </button>
              ) : null}
              {isOpen ? (
                <ul className="st-imglist st-quick-cat__list" id={listId} aria-label={`${presetTitle(c.id, days)}: what goes`}>
                  {c.kind === "images"
                    ? c.images.map((img) => {
                        const age = formatSince(parseDockerTime(img.created));
                        return (
                          <li key={img.id}>
                            <span className="st-imglist__name">{imageName(img)}</span>
                            <span className="st-imglist__id mono">
                              {shortId(img.id)}
                              {age ? ` · created ${age} ago` : ""}
                              {isBuiltHere(img) ? (
                                <span className="st-imglist__built" title={BUILT_HERE_TITLE}>
                                  {" "}
                                  · built here
                                </span>
                              ) : null}
                            </span>
                            <span className="st-imglist__size mono">{formatBytes(img.sizeBytes)}</span>
                          </li>
                        );
                      })
                    : c.containers.map((ctr) => {
                        const age = formatSince(parseDockerTime(ctr.finishedAt));
                        const img = data.images.find((i) => i.id === ctr.imageId);
                        return (
                          <li key={ctr.id}>
                            <span className="st-imglist__name">{ctr.name}</span>
                            <span className="st-imglist__id">{img ? imageName(img) : "image removed"}</span>
                            <span className="st-imglist__size">{age ? `exited ${age} ago` : ctr.state}</span>
                          </li>
                        );
                      })}
                </ul>
              ) : null}
            </li>
          );
        })}
      </ul>

      {problem && !problem.password ? (
        // Right under what was to be cleaned, so a refusal is seen at once.
        <div className="modal-sheet__error st-problem" role="alert" ref={problemRef}>
          <AlertTriangleIcon className="h-3.5 w-3.5 shrink-0" />
          <span>{problem.text}</span>
        </div>
      ) : null}

      {builtHere.length > 0 ? (
        <label className="check-row st-quick-built">
          <input type="checkbox" checked={includeBuiltHere} disabled={busy} onChange={(e) => setIncludeBuiltHere(e.target.checked)} />
          <span>
            Also include {builtHere.length === 1 ? "the image" : `the ${builtHere.length} images`} built on this Spark
            <small className="st-hint">
              No registry copy is recorded for {builtHere.length === 1 ? "it" : "them"}, so {builtHere.length === 1 ? "it" : "they"} may not be re-creatable:
              removing one may delete the only copy. Left out unless ticked.
            </small>
          </span>
        </label>
      ) : null}

      {offersPeers ? (
        <PeersBlock
          hint={`Each Spark is checked with the same rule on its own list. Tick the ones to clean up too; build cache is cleared on ${spark.name} only.`}
          rows={peerRows.map((r) => r.view)}
          picked={picked}
          busy={busy}
          onToggle={(id) => setPicked((prev) => toggled(prev, id))}
        />
      ) : null}

      {asAdmin ? (
        <AdminFields access={access} disabled={busy} purpose="to run Docker as administrator" problem={problem?.password ? problem.text : null} onSubmit={() => void run()} />
      ) : null}

      {/* Always laid out, shown while it runs: the sheet keeps its size. */}
      <p className={`st-hint st-quick-progress st-reserve${busy ? "" : " is-off"}`} role="status" aria-live="polite">
        {busy ? progress || "Starting…" : " "}
      </p>
    </StorageDialog>
  );
}
