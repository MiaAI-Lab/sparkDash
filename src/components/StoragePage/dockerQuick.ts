/**
 * Quick clean-up on the Docker tab: the presets, the rules that pick what each one would remove from a Spark's own
 * Docker list, and how their sizes are worded. Pure: no requests, no React.
 *
 * Honesty rules this module keeps (Storage Manager roadmap §2, §7):
 * - Only what Docker reports as unused is picked: an image no container uses (not even a stopped one), a container
 *   that is stopped. A list whose container query failed offers nothing ("in use" is then unknown).
 * - Docker records no "last used" time for images: an image's age is when it was created. Containers go by when they
 *   last stopped, build cache by when Docker last used it. An unknown time never counts as old.
 * - Images with no registry digest ("built here, not pulled") are kept unless the person asks to include them.
 * - Image sizes overlap (images share layers), so they are never added up into an "about": the figure is Docker's own
 *   estimate when it covers exactly the chosen set, otherwise an upper bound that says so.
 */
import type { DockerContainer, DockerImage, DockerStorage, DockerRemoveResult, StorageFilesystem } from "../../api/types";
import { formatBytes } from "../../shared/formatBytes";
import { mainFilesystem, statusView } from "../../shared/mainFilesystem";
import { isBuiltHere } from "./dockerProvenance";

/** The ages the time-based presets offer, in days. */
export const QUICK_DAYS = [1, 7, 30] as const;
export type QuickDays = (typeof QUICK_DAYS)[number];
export const DEFAULT_QUICK_DAYS: QuickDays = 7;
export const isQuickDays = (v: unknown): v is QuickDays => (QUICK_DAYS as readonly unknown[]).includes(v);

export type QuickPresetId = "old-images" | "dangling-images" | "unused-images" | "old-containers" | "build-cache";
/** The rows of the card, in order. */
export const QUICK_PRESETS: readonly QuickPresetId[] = ["old-images", "dangling-images", "unused-images", "old-containers", "build-cache"];
/** What "Recommended clean-up" opens with ticked. */
export const RECOMMENDED_PRESETS: readonly QuickPresetId[] = ["old-images", "old-containers", "build-cache"];

export type QuickKind = "images" | "containers" | "build-cache";
export const presetKind = (id: QuickPresetId): QuickKind => (id === "old-containers" ? "containers" : id === "build-cache" ? "build-cache" : "images");

/** What a rule is applied with: the age in days, the clock, and whether images built on the Spark may go too. */
export interface QuickRule {
  days: number;
  now: number;
  includeBuiltHere: boolean;
}

const DAY_MS = 86_400_000;
/** Earlier than this a time Docker reports is a placeholder (its zero time, a reproducible build's epoch), not a real one. */
const EARLIEST_REAL_TIME = Date.UTC(2000, 0, 1);
const DOCKER_TIME = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/** A time Docker printed (RFC 3339, up to nanoseconds) in epoch ms; null when missing, malformed or a placeholder. */
export function parseDockerTime(text: string | null | undefined): number | null {
  if (typeof text !== "string") return null;
  const m = DOCKER_TIME.exec(text.trim());
  if (!m) return null;
  // Milliseconds are enough, and not every engine reads nine fraction digits.
  const ms = Date.parse(`${m[1]}${m[2] ? m[2].slice(0, 4) : ""}${m[3]}`);
  return Number.isFinite(ms) && ms >= EARLIEST_REAL_TIME ? ms : null;
}

/** More than `days` days before `now`. An unknown time is never old enough; exactly `days` is not "more than". */
export function isOlderThan(time: number | null, days: number, now: number): boolean {
  return time != null && now - time > days * DAY_MS;
}

export const daysText = (days: number) => `${days} day${days === 1 ? "" : "s"}`;
export const countText = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

/** Why nothing can be offered from this list (Docker did not list its containers), or null. */
export function usageUnknownReason(data: DockerStorage): string | null {
  return data.listing && data.listing.containers !== "ok" ? "Docker did not list its containers, so what is in use is unknown" : null;
}

/** Whether an image preset picks this image, before the built-here rule. */
function imageMatches(id: QuickPresetId, img: DockerImage, rule: QuickRule): boolean {
  // "unused": the Spark listed every container and none, running or stopped, uses it.
  if (img.status !== "unused") return false;
  if (id === "unused-images") return true;
  if (id === "dangling-images") return img.tags.length === 0;
  if (id === "old-images") return isOlderThan(parseDockerTime(img.created), rule.days, rule.now);
  return false;
}

export interface ImagePick {
  /** What the preset would remove. */
  items: DockerImage[];
  /** What it matched but keeps because it was built here (empty when those are included). */
  keptBuiltHere: DockerImage[];
}

export function pickImages(data: DockerStorage, id: QuickPresetId, rule: QuickRule): ImagePick {
  const items: DockerImage[] = [];
  const keptBuiltHere: DockerImage[] = [];
  if (presetKind(id) !== "images" || usageUnknownReason(data)) return { items, keptBuiltHere };
  const seen = new Set<string>();
  for (const img of data.images) {
    if (seen.has(img.id) || !imageMatches(id, img, rule)) continue;
    seen.add(img.id);
    if (isBuiltHere(img) && !rule.includeBuiltHere) keptBuiltHere.push(img);
    else items.push(img);
  }
  return { items, keptBuiltHere };
}

/** Stopped containers that last stopped more than `days` ago. Never a running one, never one with an unknown time. */
export function pickContainers(data: DockerStorage, rule: QuickRule): DockerContainer[] {
  if (usageUnknownReason(data)) return [];
  const seen = new Set<string>();
  return (data.containers ?? []).filter((c) => {
    if (seen.has(c.id) || !c.removable || !isOlderThan(parseDockerTime(c.finishedAt), rule.days, rule.now)) return false;
    seen.add(c.id);
    return true;
  });
}

/** Docker's build-cache figure is known and says there is nothing to reclaim. */
export function buildCacheEmpty(data: DockerStorage): boolean {
  const row = data.usage.buildCache;
  return row != null && (row.reclaimableBytes === 0 || row.count === 0);
}

/** Everything a set of presets would do on one Spark, each image and container once. */
export interface QuickPlan {
  images: DockerImage[];
  containers: DockerContainer[];
  buildCache: boolean;
  /** Matched but kept because built here. */
  keptBuiltHere: DockerImage[];
}

export function planFor(data: DockerStorage, presets: readonly QuickPresetId[], rule: QuickRule): QuickPlan {
  const images = new Map<string, DockerImage>();
  const kept = new Map<string, DockerImage>();
  const containers = new Map<string, DockerContainer>();
  let buildCache = false;
  for (const id of presets) {
    const kind = presetKind(id);
    if (kind === "build-cache") buildCache = true;
    else if (kind === "containers") for (const c of pickContainers(data, rule)) containers.set(c.id, c);
    else {
      const pick = pickImages(data, id, rule);
      for (const img of pick.items) images.set(img.id, img);
      for (const img of pick.keptBuiltHere) kept.set(img.id, img);
    }
  }
  return {
    images: [...images.values()],
    containers: [...containers.values()],
    buildCache,
    keptBuiltHere: [...kept.values()].filter((img) => !images.has(img.id)),
  };
}

/**
 * How much a set frees. "about": Docker's own estimate, which covers exactly this set. "up-to": an upper bound, either
 * the images' sizes added up (they share layers, so less is freed) or Docker's estimate for a bigger set.
 */
export type SizeEstimate =
  | { kind: "none" }
  | { kind: "about"; bytes: number }
  | { kind: "up-to"; bytes: number; basis: "layers" | "docker" }
  | { kind: "unknown" };

export function imagesEstimate(chosen: readonly DockerImage[], data: DockerStorage): SizeEstimate {
  const byId = new Map(chosen.map((i) => [i.id, i]));
  if (byId.size === 0) return { kind: "none" };
  const reclaimable = data.usage.images?.reclaimableBytes ?? null;
  const unused = data.images.filter((i) => i.status === "unused");
  const everyUnused = unused.length === byId.size && unused.every((i) => byId.has(i.id));
  if (everyUnused && reclaimable != null) return { kind: "about", bytes: reclaimable };
  const sizes = [...byId.values()].map((i) => i.sizeBytes);
  const sum = sizes.every((s): s is number => s != null && Number.isFinite(s)) ? sizes.reduce((a, b) => a + b, 0) : null;
  // Removing some unused images never frees more than removing all of them (Docker's figure).
  if (sum != null && (reclaimable == null || sum <= reclaimable)) return { kind: "up-to", bytes: sum, basis: "layers" };
  if (reclaimable != null) return { kind: "up-to", bytes: reclaimable, basis: "docker" };
  return { kind: "unknown" };
}

const ACTIVE_STATES = new Set(["running", "paused", "restarting"]);

export function containersEstimate(chosen: readonly DockerContainer[], data: DockerStorage): SizeEstimate {
  const ids = new Set(chosen.map((c) => c.id));
  if (ids.size === 0) return { kind: "none" };
  // The list has no per-container size; Docker's figure covers every container that is not active (running, paused
  // or restarting).
  const reclaimable = data.usage.containers?.reclaimableBytes ?? null;
  if (reclaimable == null) return { kind: "unknown" };
  const inactive = (data.containers ?? []).filter((c) => !ACTIVE_STATES.has(c.state));
  const every = inactive.length === ids.size && inactive.every((c) => ids.has(c.id));
  return every ? { kind: "about", bytes: reclaimable } : { kind: "up-to", bytes: reclaimable, basis: "docker" };
}

/** The age filter is applied by Docker, so its figure (all unused build cache) is an upper bound. */
export function buildCacheEstimate(data: DockerStorage): SizeEstimate {
  const bytes = data.usage.buildCache?.reclaimableBytes;
  return bytes == null ? { kind: "unknown" } : { kind: "up-to", bytes, basis: "docker" };
}

const SCOPE: Record<QuickKind, string> = {
  images: "every unused image",
  containers: "every stopped container",
  "build-cache": "all unused build cache",
};

/** "about 37.3 GB (Docker's estimate)", "up to 12 GB (images share layers)", … for a kind of item. */
export function estimateText(e: SizeEstimate, kind: QuickKind): string {
  switch (e.kind) {
    case "about":
      return `about ${formatBytes(e.bytes)} (Docker's estimate)`;
    case "up-to":
      return e.basis === "layers" ? `up to ${formatBytes(e.bytes)} (images share layers)` : `up to about ${formatBytes(e.bytes)} (Docker's estimate for ${SCOPE[kind]})`;
    case "unknown":
      return "size not measured";
    default:
      return "";
  }
}

/** The same, short, for a one-line summary: "about 37.3 GB", "up to 12 GB", or "" when unknown. */
export function shortEstimate(e: SizeEstimate): string {
  return e.kind === "about" ? `about ${formatBytes(e.bytes)}` : e.kind === "up-to" ? `up to ${formatBytes(e.bytes)}` : "";
}

export function presetTitle(id: QuickPresetId, days: number): string {
  switch (id) {
    case "old-images":
      return `Unused images created more than ${daysText(days)} ago`;
    case "dangling-images":
      return "Dangling images";
    case "unused-images":
      return "All unused images";
    case "old-containers":
      return `Stopped containers that exited more than ${daysText(days)} ago`;
    case "build-cache":
      return `Build cache not used in the last ${daysText(days)}`;
  }
}

export function presetDescription(id: QuickPresetId): string {
  switch (id) {
    case "old-images":
      return "No container uses them, not even a stopped one. Docker keeps no “last used” date for images, so the age is when the image was created.";
    case "dangling-images":
      return "Untagged images (<none>), usually left behind when a tag is built or pulled again. No container uses them.";
    case "unused-images":
      return "Every image no container uses, whatever its age.";
    case "old-containers":
      return "Removing one deletes its writable layer: anything written inside it that is not in a volume. Volumes are kept.";
    case "build-cache":
      return "Layers Docker keeps to speed up builds. Docker removes only cache no build is using; the next build may take longer.";
  }
}

/** The risk class shown with each kind (roadmap §2 wording; nothing is called safe). */
export function presetClass(id: QuickPresetId): { label: string; tone: "warn" | "bad" | "info" } {
  const kind = presetKind(id);
  return kind === "images" ? { label: "Review first", tone: "warn" } : kind === "containers" ? { label: "Careful", tone: "bad" } : { label: "Rebuilt when needed", tone: "info" };
}

/**
 * The primary button: exactly what it does. "Remove 12 images and 3 containers", "…, clear build cache",
 * "… on 3 Sparks" when other Sparks take part ("… on Spark Two" when only that one removes anything);
 * "Nothing selected" when nothing is ticked.
 */
export function actionLabel({ images, containers, buildCache, sparks = 1, where }: { images: number; containers: number; buildCache: boolean; sparks?: number; where?: string }): string {
  const things = [images > 0 ? countText(images, "image") : "", containers > 0 ? countText(containers, "container") : ""].filter(Boolean);
  const place = sparks > 1 ? ` on ${sparks} Sparks` : where ? ` on ${where}` : "";
  const removal = things.length > 0 ? `Remove ${things.join(" and ")}${place}` : "";
  if (!removal) return buildCache ? "Clear build cache" : "Nothing selected";
  return buildCache ? `${removal}, clear build cache` : removal;
}

// ─── After a run ─────────────────────────────────────────

/** What one Spark did. A step is null when it was not asked for; `error` when the request itself failed. */
export interface SparkRun {
  sparkId: string;
  name: string;
  images: DockerRemoveResult | null;
  containers: DockerRemoveResult | null;
  /** Build cache was cleared; `reclaimedBytes` is what Docker says it reclaimed (null: it did not say). */
  buildCache: { reclaimedBytes: number | null } | null;
  errors: { step: QuickKind; message: string }[];
  /** Names for the IDs, for the report. */
  names: Record<string, string>;
}

const SKIP_REASONS: Record<string, string> = {
  "in-use": "a container uses it now",
  running: "it is running again",
  gone: "it was already gone",
  invalid: "not a valid ID",
};

function skipText(kind: QuickKind, reason: string): string {
  if (reason === "check-failed") return kind === "containers" ? "Docker could not confirm it is stopped" : "Docker could not confirm nothing uses it";
  return SKIP_REASONS[reason] ?? reason;
}

/** "Removed 4 images and 2 containers, and cleared build cache." for one Spark, or what could not be done. */
export function runSentence(run: SparkRun): string {
  const parts: string[] = [];
  const removed = [run.images && run.images.removed.length > 0 ? countText(run.images.removed.length, "image") : "", run.containers && run.containers.removed.length > 0 ? countText(run.containers.removed.length, "container") : ""].filter(Boolean);
  if (removed.length > 0) parts.push(`removed ${removed.join(" and ")}`);
  if (run.buildCache) parts.push("cleared build cache");
  const asked = run.images != null || run.containers != null || run.buildCache != null;
  let text = parts.length === 0 ? (asked ? "nothing was removed" : "") : parts.length === 1 ? parts[0] : `${parts[0]}, and ${parts[1]}`;
  if (run.errors.length > 0) text = `${text ? `${text}; ` : ""}${run.errors.map((e) => `${e.step === "build-cache" ? "build cache" : e.step} could not be cleaned (${e.message})`).join("; ")}`;
  return text;
}

/** What a quick clean-up did: this Spark first, then the other Sparks that took part. */
export interface QuickOutcome {
  runs: SparkRun[];
  /** Docker's own figures, as sentences ("Docker reports 1.2 GB of build cache reclaimed."). */
  figures: string[];
  /** "Available space on / changed by …", or null when the disks could not be read before and after. */
  space: string | null;
}

/**
 * The result in plain counts, then Docker's own figures, each other Spark, and the change in available space; the
 * items that were kept or failed, per Spark, for a disclosure. Nothing here claims bytes the clean-up freed.
 */
export function outcomeSummary(o: QuickOutcome): { text: string; tone: "ok" | "info" | "warn"; problems: { name: string; lines: string[] }[] } {
  const [here, ...others] = o.runs;
  const sentences: string[] = [];
  const first = here ? runSentence(here) : "";
  if (first) sentences.push(`${first.charAt(0).toUpperCase()}${first.slice(1)}.`);
  sentences.push(...o.figures);
  for (const r of others) sentences.push(`${r.name}: ${runSentence(r) || "nothing was asked"}.`);
  if (o.space) sentences.push(o.space);
  const problems = o.runs.map((r) => ({ name: r.name, lines: runProblems(r) })).filter((p) => p.lines.length > 0);
  const kept = problems.reduce((n, p) => n + p.lines.length, 0);
  if (kept > 0) sentences.push(`${countText(kept, "item")} ${kept === 1 ? "was" : "were"} kept or could not be removed (listed below).`);
  const failed = o.runs.some((r) => r.errors.length > 0 || (r.images?.failed.length ?? 0) > 0 || (r.containers?.failed.length ?? 0) > 0);
  const did = o.runs.some((r) => (r.images?.removed.length ?? 0) + (r.containers?.removed.length ?? 0) > 0 || r.buildCache != null);
  return { text: sentences.join(" "), tone: failed ? "warn" : did ? "ok" : "info", problems };
}

/** Items that were skipped or failed, one line each, for the disclosure under the result. */
export function runProblems(run: SparkRun): string[] {
  const lines: string[] = [];
  const name = (id: string) => run.names[id] ?? id.replace(/^sha256:/, "").slice(0, 12);
  for (const [kind, res] of [["images", run.images], ["containers", run.containers]] as const) {
    if (!res) continue;
    for (const s of res.skipped) lines.push(`${name(s.id)}: kept, ${skipText(kind, s.reason)}`);
    for (const f of res.failed) lines.push(`${name(f.id)}: could not be removed (${f.message || "Docker refused"})`);
  }
  return lines;
}

/** The filesystem Docker keeps its data on (the longest mount that holds its root folder), else the main disk. */
export function dockerFilesystem(filesystems: readonly StorageFilesystem[] | null | undefined, rootDir: string | null): StorageFilesystem | null {
  const list = filesystems ?? [];
  if (rootDir && rootDir.startsWith("/")) {
    let best: StorageFilesystem | null = null;
    for (const fs of list) {
      const holds = fs.mount === "/" || rootDir === fs.mount || rootDir.startsWith(`${fs.mount}/`);
      if (holds && (!best || fs.mount.length > best.mount.length)) best = fs;
    }
    if (best) return best;
  }
  return mainFilesystem(list, statusView);
}

/**
 * "Available space on / changed by +9.6 GB while this ran." Never claimed as what the clean-up freed: other programs
 * write to the disk too, so it can be zero or negative.
 */
export function spaceChangeText(before: StorageFilesystem, after: StorageFilesystem): string {
  const delta = after.availBytes - before.availBytes;
  if (delta === 0) return `Available space on ${before.mount} did not change while this ran.`;
  return `Available space on ${before.mount} changed by ${delta > 0 ? "+" : "−"}${formatBytes(Math.abs(delta))} while this ran.`;
}
