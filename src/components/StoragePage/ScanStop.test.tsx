import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cancelStorageScan, fetchStorageScan, fetchStorageStatus } from "../../api/client";
import type { StorageScanJob, StorageScanSnapshot, StorageStatus } from "../../api/types";
import { makeSpark } from "../../testing/fixtures";
import { flush, render } from "../../testing/render";
import { ScanProgress, minutesUntil, scanHoldNote, scanStopNote } from "./ScanProgress";
import { StoragePage } from "./StoragePage";

vi.mock("../../api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/client")>()),
  fetchStorageStatus: vi.fn(),
  fetchStorageContext: vi.fn(),
  fetchStorageScan: vi.fn(),
  startStorageScan: vi.fn(),
  cancelStorageScan: vi.fn(),
  deleteStoragePath: vi.fn(),
  fetchDockerStorage: vi.fn(),
  fetchStorageQuarantine: vi.fn(async () => ({ items: [] })),
  removeDockerImages: vi.fn(),
  removeDockerContainers: vi.fn(),
  forgetStorageSudo: vi.fn(),
}));

const NOW = 1_800_000_000_000;
const RUNNING: StorageScanJob = {
  id: "j1",
  state: "running",
  path: "/",
  depth: 3,
  mode: "new",
  elevated: false,
  startedAt: NOW - 20_000,
  finishedAt: null,
  error: null,
  cancellable: true,
  cancelBestEffort: false,
  stopsByItselfAt: null,
  stop: null,
  holdsSpark: true,
  holdReason: "running",
  holdUntil: null,
};
const STATUS: StorageStatus = {
  user: "me",
  sudo: "no",
  passwordAllowed: true,
  filesystems: [{ source: "/dev/nvme0n1p2", fstype: "ext4", mount: "/", totalBytes: 1000e9, usedBytes: 400e9, availBytes: 600e9 }],
  docker: { state: "ok", rootDir: "/var/lib/docker" },
};

const text = () => document.body.textContent ?? "";
const buttons = () => [...document.body.querySelectorAll("button")];
const button = (label: string) => buttons().find((b) => b.textContent?.includes(label)) as HTMLButtonElement | undefined;

function progress(job: StorageScanJob, onStop = () => {}, requesting = false) {
  render(<ScanProgress sparkName="Spark One" path="/" elapsedMs={20_000} job={job} serverNow={() => NOW} onStop={onStop} requesting={requesting} />);
}

describe("ScanProgress", () => {
  it("offers Stop scan for an ordinary scan, with an empty reserved note line", () => {
    const onStop = vi.fn();
    progress(RUNNING, onStop);
    const stop = button("Stop scan")!;
    expect(stop.disabled).toBe(false);
    act(() => stop.click());
    expect(onStop).toHaveBeenCalledTimes(1);
    const note = document.body.querySelector(".st-progress__note")!;
    expect(note).not.toBeNull();
    expect(note.textContent).toBe("");
  });

  it("says Stopping… while the Spark has not confirmed, and the same button keeps its place", () => {
    progress({ ...RUNNING, state: "stopping", stop: { requestedAt: NOW, outcome: "pending", message: null }, holdReason: "stopping" });
    const stop = button("Stopping…")!;
    expect(stop.disabled).toBe(true);
    expect(stop.classList.contains("st-stop")).toBe(true);
    expect(text()).toContain("Stopping the analysis of");
  });

  it("says plainly when the stop could not be confirmed, and lets it be tried again", () => {
    const message = "Could not confirm it stopped — the Spark stays busy until it does. Some of its processes were still running after being told to stop.";
    progress({ ...RUNNING, state: "stopping", stop: { requestedAt: NOW, outcome: "not-terminated", message }, holdReason: "unconfirmed" });
    expect(text()).toContain("Could not confirm it stopped — the Spark stays busy until it does.");
    const note = document.body.querySelector(".st-progress__note")!;
    expect(note.classList.contains("is-warn")).toBe(true);
    expect(note.getAttribute("role")).toBe("alert");
    expect(button("Try stopping again")!.disabled).toBe(false);
  });

  it("offers no stop for a scan run as administrator: it says when it stops by itself", () => {
    progress({ ...RUNNING, elevated: true, cancellable: false, stopsByItselfAt: NOW + 4 * 60_000 + 10_000 });
    expect(button("Stop")).toBeUndefined();
    expect(text()).toContain("Stops by itself in 5 min");
    expect(text()).toContain("This scan runs as administrator, so the dashboard cannot stop it. It will stop by itself in 5 min at the latest.");
  });

  it("says stopping is best effort when the dashboard runs in a container", () => {
    progress({ ...RUNNING, cancelBestEffort: true });
    expect(button("Stop scan")).toBeDefined();
    expect(text()).toContain("Stopping is best effort here");
  });
});

describe("scan notes", () => {
  it("rounds minutes up and never says 0", () => {
    expect(minutesUntil(NOW + 61_000, NOW)).toBe(2);
    expect(minutesUntil(NOW - 5_000, NOW)).toBe(1);
    expect(minutesUntil(null, NOW)).toBeNull();
  });

  it("explains why the Spark is still busy, including after lost contact", () => {
    expect(scanHoldNote(null, NOW)).toBeNull();
    expect(scanHoldNote({ ...RUNNING, state: "done", holdsSpark: false }, NOW)).toBeNull();
    expect(scanHoldNote(RUNNING, NOW)).toBe("A scan is still running on this Spark.");
    expect(scanHoldNote({ ...RUNNING, state: "error", error: { code: "unreachable", message: "x" }, holdReason: "unreachable", holdUntil: NOW + 10 * 60_000 }, NOW)).toMatch(
      /lost contact .* stays busy until the dashboard can confirm the scan has ended \(in 10 min at the latest\)/
    );
    expect(scanStopNote(RUNNING, NOW)).toBeNull();
  });
});

describe("Stop scan on the page", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "Date"] });
    vi.setSystemTime(NOW);
    window.history.replaceState(null, "", "/storage");
    vi.mocked(fetchStorageStatus).mockResolvedValue(STATUS);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("stops the scan, keeps following it while the Spark is busy, and says when it has stopped", async () => {
    const snap = (job: StorageScanJob): StorageScanSnapshot => ({ job, revision: 0, session: null, now: Date.now() });
    vi.mocked(fetchStorageScan).mockResolvedValue(snap(RUNNING));
    const stopping: StorageScanJob = { ...RUNNING, state: "stopping", stop: { requestedAt: NOW, outcome: "pending", message: null }, holdReason: "stopping" };
    vi.mocked(cancelStorageScan).mockResolvedValue({ job: stopping });
    render(<StoragePage sparks={[makeSpark("s1")]} />);
    await flush();
    await flush();
    expect(text()).toContain("Analysing");
    await act(async () => button("Stop scan")!.click());
    expect(cancelStorageScan).toHaveBeenCalledWith("s1");
    expect(button("Stopping…")!.disabled).toBe(true);

    // The Spark could not confirm: the page keeps the scan on screen and says why.
    const message = "Could not confirm it stopped — the Spark stays busy until it does. The Spark could not be reached.";
    vi.mocked(fetchStorageScan).mockResolvedValue(snap({ ...stopping, stop: { requestedAt: NOW, outcome: "unknown", message }, holdReason: "unconfirmed" }));
    await act(async () => vi.advanceTimersByTime(1600));
    await flush();
    expect(text()).toContain("Could not confirm it stopped — the Spark stays busy until it does.");

    // Confirmed later: the Spark is free, and the page says it stopped.
    vi.mocked(fetchStorageScan).mockResolvedValue(
      snap({ ...stopping, state: "cancelled", finishedAt: NOW + 3000, stop: { requestedAt: NOW, outcome: "terminated", message: "Stopped: the Spark has confirmed nothing of the scan is left running." }, holdsSpark: false, holdReason: null })
    );
    await act(async () => vi.advanceTimersByTime(1600));
    await flush();
    expect(text()).toContain("Scan stopped.");
    expect(text()).not.toContain("Could not confirm");
    const polls = vi.mocked(fetchStorageScan).mock.calls.length;
    await act(async () => vi.advanceTimersByTime(5000));
    expect(vi.mocked(fetchStorageScan).mock.calls.length).toBe(polls);
  });
});
