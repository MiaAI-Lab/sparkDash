import { describe, expect, it } from "vitest";
import type { DockerContainer, DockerImage, DockerStorage, StorageFilesystem } from "../../api/types";
import {
  actionLabel,
  buildCacheEmpty,
  buildCacheEstimate,
  containersEstimate,
  dockerFilesystem,
  estimateText,
  imagesEstimate,
  isOlderThan,
  outcomeSummary,
  parseDockerTime,
  pickContainers,
  pickImages,
  planFor,
  presetTitle,
  QUICK_PRESETS,
  shortEstimate,
  spaceChangeText,
  usageUnknownReason,
  type SparkRun,
} from "./dockerQuick";

const NOW = Date.UTC(2026, 9, 26, 12, 0, 0);
const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();
const ID = (c: string) => `sha256:${c.repeat(64)}`;
const CID = (c: string) => c.repeat(64);
const GB = 1024 ** 3;

const img = (c: string, extra: Partial<DockerImage> = {}): DockerImage => ({
  id: ID(c),
  tags: [`${c}:1`],
  sizeBytes: 1e9,
  created: iso(NOW - 30 * DAY),
  usedBy: [],
  status: "unused",
  registryDigest: true,
  ...extra,
});
const ctr = (c: string, extra: Partial<DockerContainer> = {}): DockerContainer => ({
  id: CID(c),
  name: `job-${c}`,
  state: "exited",
  imageId: ID("z"),
  created: iso(NOW - 40 * DAY),
  removable: true,
  finishedAt: iso(NOW - 20 * DAY),
  ...extra,
});
const list = (images: DockerImage[], containers: DockerContainer[] = [], usage: DockerStorage["usage"] = {}, containersListed: "ok" | "failed" = "ok"): DockerStorage => ({
  rootDir: "/var/lib/docker",
  usage,
  images,
  containers,
  listing: { images: "ok", containers: containersListed },
});
const rule = (days = 7, includeBuiltHere = false) => ({ days, now: NOW, includeBuiltHere });
const ids = (xs: { id: string }[]) => xs.map((x) => x.id);

describe("times Docker reports", () => {
  it("reads RFC 3339 times, with nanoseconds or an offset", () => {
    expect(parseDockerTime("2026-10-01T00:00:00Z")).toBe(Date.UTC(2026, 9, 1));
    expect(parseDockerTime("2026-10-01T00:00:00.123456789Z")).toBe(Date.UTC(2026, 9, 1, 0, 0, 0, 123));
    expect(parseDockerTime("2026-10-01T02:00:00+02:00")).toBe(Date.UTC(2026, 9, 1));
  });

  it("treats missing, malformed and placeholder times as unknown", () => {
    for (const t of [null, undefined, "", "garbage", "2026-10-01", "0001-01-01T00:00:00Z", "1970-01-01T00:00:00Z", "1999-12-31T23:59:59Z"]) {
      expect(parseDockerTime(t), String(t)).toBeNull();
    }
  });

  it("'more than N days': exactly N days is not old enough, a millisecond more is; unknown and future never are", () => {
    expect(isOlderThan(NOW - 7 * DAY, 7, NOW)).toBe(false);
    expect(isOlderThan(NOW - 7 * DAY - 1, 7, NOW)).toBe(true);
    expect(isOlderThan(null, 7, NOW)).toBe(false);
    expect(isOlderThan(NOW + DAY, 1, NOW)).toBe(false);
  });
});

describe("image presets", () => {
  it("old images go by creation time, at the boundary, and never with an unknown time", () => {
    const data = list([
      img("a", { created: iso(NOW - 7 * DAY) }), // exactly 7 days: kept
      img("b", { created: iso(NOW - 7 * DAY - 1000) }),
      img("c", { created: null }),
      img("d", { created: "0001-01-01T00:00:00Z" }),
      img("e", { created: "1970-01-01T00:00:00Z" }),
      img("f", { created: "not a date" }),
    ]);
    expect(ids(pickImages(data, "old-images", rule(7)).items)).toEqual([ID("b")]);
    expect(ids(pickImages(data, "old-images", rule(1)).items)).toEqual([ID("a"), ID("b")]);
  });

  it("never picks an image a container uses, running or stopped, or whose use is unknown", () => {
    const old = iso(NOW - 90 * DAY);
    const data = list([
      img("a", { created: old, status: "running", usedBy: [{ name: "web", state: "running" }] }),
      img("b", { created: old, status: "stopped", usedBy: [{ name: "job", state: "exited" }] }),
      img("c", { created: old, status: "unknown" }),
      img("d", { created: old, tags: [] }),
    ]);
    for (const id of ["old-images", "dangling-images", "unused-images"] as const) expect(ids(pickImages(data, id, rule(1)).items), id).toEqual([ID("d")]);
  });

  it("dangling means untagged, whatever its age", () => {
    const data = list([img("a", { tags: [], created: iso(NOW - DAY / 2) }), img("b"), img("c", { tags: [], created: null })]);
    expect(ids(pickImages(data, "dangling-images", rule(30)).items)).toEqual([ID("a"), ID("c")]);
  });

  it("keeps images built here (no registry digest) unless asked, and never guesses provenance it was not told", () => {
    const data = list([img("a", { registryDigest: false }), img("b", { registryDigest: null }), img("c", { registryDigest: undefined }), img("d")]);
    const kept = pickImages(data, "unused-images", rule());
    expect(ids(kept.items)).toEqual([ID("b"), ID("c"), ID("d")]);
    expect(ids(kept.keptBuiltHere)).toEqual([ID("a")]);
    const all = pickImages(data, "unused-images", rule(7, true));
    expect(ids(all.items)).toEqual([ID("a"), ID("b"), ID("c"), ID("d")]);
    expect(all.keptBuiltHere).toEqual([]);
  });

  it("offers nothing when Docker did not list its containers, even if a status says unused", () => {
    const data = list([img("a")], [ctr("1")], {}, "failed");
    expect(usageUnknownReason(data)).toMatch(/did not list its containers/);
    for (const id of QUICK_PRESETS) expect(pickImages(data, id, rule()).items).toEqual([]);
    expect(pickContainers(data, rule())).toEqual([]);
  });
});

describe("stopped containers", () => {
  it("go by when they last stopped, at the boundary; unknown times, running and never-started ones never match", () => {
    const data = list(
      [],
      [
        ctr("1", { finishedAt: iso(NOW - 7 * DAY) }),
        ctr("2", { finishedAt: iso(NOW - 7 * DAY - 1000) }),
        ctr("3", { finishedAt: undefined }),
        ctr("4", { finishedAt: "0001-01-01T00:00:00Z", state: "created" }),
        ctr("5", { state: "running", removable: false, finishedAt: iso(NOW - 90 * DAY) }),
        ctr("6", { state: "dead", finishedAt: iso(NOW - 9 * DAY) }),
        ctr("7", { finishedAt: null }),
      ]
    );
    expect(ids(pickContainers(data, rule(7)))).toEqual([CID("2"), CID("6")]);
  });
});

describe("plans", () => {
  it("lists each image and container once, however many presets pick it", () => {
    const data = list([img("a", { tags: [] }), img("b"), img("c", { registryDigest: false })], [ctr("1"), ctr("1")]);
    const plan = planFor(data, ["old-images", "dangling-images", "unused-images", "old-containers", "build-cache"], rule());
    expect(ids(plan.images)).toEqual([ID("a"), ID("b")]);
    expect(ids(plan.containers)).toEqual([CID("1")]);
    expect(plan.buildCache).toBe(true);
    expect(ids(plan.keptBuiltHere)).toEqual([ID("c")]);
    expect(planFor(data, ["unused-images"], rule(7, true)).keptBuiltHere).toEqual([]);
  });

  it("an empty Docker gives an empty plan and nothing to estimate", () => {
    const data = list([]);
    const plan = planFor(data, QUICK_PRESETS, rule());
    expect(plan.images).toEqual([]);
    expect(plan.containers).toEqual([]);
    expect(imagesEstimate(plan.images, data)).toEqual({ kind: "none" });
    expect(containersEstimate(plan.containers, data)).toEqual({ kind: "none" });
    expect(buildCacheEstimate(data)).toEqual({ kind: "unknown" });
    expect(buildCacheEmpty(data)).toBe(false);
  });
});

describe("sizes are never added up into an 'about'", () => {
  const images = [img("a", { sizeBytes: 4 * GB }), img("b", { sizeBytes: 3 * GB }), img("c", { sizeBytes: 2 * GB })];

  it("uses Docker's estimate when the set is exactly every unused image", () => {
    const data = list(images, [], { images: { count: 3, active: 0, sizeBytes: 9 * GB, reclaimableBytes: 5 * GB } });
    expect(imagesEstimate(images, data)).toEqual({ kind: "about", bytes: 5 * GB });
    expect(estimateText(imagesEstimate(images, data), "images")).toBe("about 5.0 GB (Docker's estimate)");
  });

  it("otherwise an upper bound: the sizes (shared layers), capped by Docker's figure for all of them", () => {
    const data = list(images, [], { images: { count: 3, active: 0, sizeBytes: 9 * GB, reclaimableBytes: 5 * GB } });
    expect(imagesEstimate([images[1]], data)).toEqual({ kind: "up-to", bytes: 3 * GB, basis: "layers" });
    expect(estimateText(imagesEstimate([images[1]], data), "images")).toBe("up to 3.0 GB (images share layers)");
    // 4 + 3 = 7 GB is more than Docker says all three free: the smaller bound, with its basis.
    expect(imagesEstimate([images[0], images[1]], data)).toEqual({ kind: "up-to", bytes: 5 * GB, basis: "docker" });
    expect(estimateText(imagesEstimate([images[0], images[1]], data), "images")).toBe("up to about 5.0 GB (Docker's estimate for every unused image)");
    // The same image twice counts once.
    expect(imagesEstimate([images[1], images[1]], data)).toEqual({ kind: "up-to", bytes: 3 * GB, basis: "layers" });
  });

  it("without Docker's figure (a light list) it is the upper bound or unknown, never 'about'", () => {
    const data = list(images);
    expect(imagesEstimate(images, data)).toEqual({ kind: "up-to", bytes: 9 * GB, basis: "layers" });
    expect(imagesEstimate([img("x", { sizeBytes: null })], list([img("x", { sizeBytes: null })]))).toEqual({ kind: "unknown" });
    expect(estimateText({ kind: "unknown" }, "images")).toBe("size not measured");
    expect(shortEstimate({ kind: "unknown" })).toBe("");
  });

  it("containers use Docker's figure for every inactive container: 'about' only when that is exactly the set", () => {
    const cs = [ctr("1"), ctr("2", { finishedAt: iso(NOW - DAY) })];
    const usage = { containers: { count: 3, active: 1, sizeBytes: 2e9, reclaimableBytes: 1e9 } };
    const data = list([], [...cs, ctr("3", { state: "running", removable: false })], usage);
    expect(containersEstimate(cs, data)).toEqual({ kind: "about", bytes: 1e9 });
    expect(containersEstimate([cs[0]], data)).toEqual({ kind: "up-to", bytes: 1e9, basis: "docker" });
    expect(estimateText(containersEstimate([cs[0]], data), "containers")).toMatch(/^up to about .* \(Docker's estimate for every stopped container\)$/);
    expect(containersEstimate(cs, list([], cs))).toEqual({ kind: "unknown" });
  });

  it("build cache: Docker's figure for all unused cache, as an upper bound; empty when Docker says nothing is reclaimable", () => {
    const data = list([], [], { buildCache: { count: 40, active: 0, sizeBytes: 10e9, reclaimableBytes: 9e9 } });
    expect(buildCacheEstimate(data)).toEqual({ kind: "up-to", bytes: 9e9, basis: "docker" });
    expect(estimateText(buildCacheEstimate(data), "build-cache")).toMatch(/Docker's estimate for all unused build cache/);
    expect(buildCacheEmpty(list([], [], { buildCache: { count: 3, active: 3, sizeBytes: 1e9, reclaimableBytes: 0 } }))).toBe(true);
    expect(buildCacheEmpty(list([], [], { buildCache: { count: 0, active: 0, sizeBytes: 0, reclaimableBytes: null } }))).toBe(true);
  });
});

describe("wording", () => {
  it("says an image's age is its creation time, never that it was unused for that long", () => {
    expect(presetTitle("old-images", 7)).toBe("Unused images created more than 7 days ago");
    expect(presetTitle("old-containers", 1)).toBe("Stopped containers that exited more than 1 day ago");
    expect(presetTitle("build-cache", 30)).toBe("Build cache not used in the last 30 days");
    for (const id of QUICK_PRESETS) expect(presetTitle(id, 7)).not.toMatch(/not used for|\bsafe\b/i);
  });

  it("the primary button says exactly what it does", () => {
    expect(actionLabel({ images: 12, containers: 3, buildCache: false })).toBe("Remove 12 images and 3 containers");
    expect(actionLabel({ images: 1, containers: 0, buildCache: true })).toBe("Remove 1 image, clear build cache");
    expect(actionLabel({ images: 0, containers: 0, buildCache: true })).toBe("Clear build cache");
    expect(actionLabel({ images: 5, containers: 1, buildCache: true, sparks: 3 })).toBe("Remove 5 images and 1 container on 3 Sparks, clear build cache");
    expect(actionLabel({ images: 2, containers: 0, buildCache: false, where: "Spark Two" })).toBe("Remove 2 images on Spark Two");
    expect(actionLabel({ images: 0, containers: 0, buildCache: false })).toBe("Nothing selected");
  });
});

describe("after a run", () => {
  const here: SparkRun = {
    sparkId: "s1",
    name: "Spark One",
    images: { success: true, removed: [ID("a"), ID("b")], skipped: [{ id: ID("c"), reason: "in-use" }], failed: [] },
    containers: { success: true, removed: [CID("1")], skipped: [], failed: [{ id: CID("2"), message: "removal in progress" }] },
    buildCache: { reclaimedBytes: 1e9 },
    errors: [],
    names: { [ID("c")]: "old:1", [CID("2")]: "job-2" },
  };

  it("reports plain counts, Docker's own figures, each other Spark, and the space change, with problems listed apart", () => {
    const peer: SparkRun = { sparkId: "s2", name: "Spark Two", images: null, containers: null, buildCache: null, errors: [{ step: "images", message: "unit busy" }], names: {} };
    const s = outcomeSummary({ runs: [here, peer], figures: ["Docker reports 954 MB of build cache reclaimed."], space: "Available space on / changed by +2.0 GB while this ran." });
    expect(s.text).toBe(
      "Removed 2 images and 1 container, and cleared build cache. Docker reports 954 MB of build cache reclaimed. Spark Two: images could not be cleaned (unit busy). Available space on / changed by +2.0 GB while this ran. 2 items were kept or could not be removed (listed below)."
    );
    expect(s.tone).toBe("warn");
    expect(s.problems).toEqual([{ name: "Spark One", lines: ["old:1: kept, a container uses it now", "job-2: could not be removed (removal in progress)"] }]);
  });

  it("a clean run is 'ok', and nothing removed is 'info'", () => {
    const ok = { ...here, images: { success: true, removed: [ID("a")], skipped: [], failed: [] }, containers: null };
    expect(outcomeSummary({ runs: [ok], figures: [], space: null }).tone).toBe("ok");
    const none = { ...here, images: { success: true, removed: [], skipped: [], failed: [] }, containers: null, buildCache: null };
    const s = outcomeSummary({ runs: [none], figures: [], space: null });
    expect(s.tone).toBe("info");
    expect(s.text).toBe("Nothing was removed.");
  });

  it("measures the filesystem Docker keeps its data on, and never calls the change freed space", () => {
    const fs = (mount: string, avail: number, source = "/dev/nvme0n1p2"): StorageFilesystem => ({ source, fstype: "ext4", mount, totalBytes: 1e12, usedBytes: 1e11, availBytes: avail });
    const disks = [fs("/", 100), fs("/data", 50, "/dev/sda1"), fs("/data/docker", 20, "/dev/sdb1")];
    expect(dockerFilesystem(disks, "/data/docker/root")?.mount).toBe("/data/docker");
    expect(dockerFilesystem(disks, "/var/lib/docker")?.mount).toBe("/");
    expect(dockerFilesystem(disks, null)?.mount).toBe("/");
    expect(spaceChangeText(fs("/", 1e9), fs("/", 3 * GB + 1e9))).toBe("Available space on / changed by +3.0 GB while this ran.");
    expect(spaceChangeText(fs("/", 2 * GB), fs("/", GB))).toBe("Available space on / changed by −1.0 GB while this ran.");
    expect(spaceChangeText(fs("/", 5), fs("/", 5))).toBe("Available space on / did not change while this ran.");
  });
});
