import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const readLauncherJob = vi.fn();
vi.mock("../api/client", () => ({
  readLauncherJob: (...a: unknown[]) => readLauncherJob(...a),
  cancelLauncherJob: vi.fn(),
}));

import { JOB_GONE_MESSAGE, isJobGone, useLauncherJob } from "./useLauncherJob";
import type { LauncherJob } from "../api/types";
import { flush, render } from "../testing/render";

const job = (id: string, sparkId = "s1"): LauncherJob => ({
  id,
  sparkId,
  launcherId: "m",
  launcherName: "M",
  action: "start",
  status: "running",
  exitCode: null,
  startedAt: 1,
  finishedAt: null,
  error: null,
});

type Api = ReturnType<typeof useLauncherJob>;

function mount(initialSpark: string) {
  const ref: { api: Api | null } = { api: null };
  function Probe({ sparkId }: { sparkId: string }) {
    ref.api = useLauncherJob(sparkId);
    return null;
  }
  const { root } = render(<Probe sparkId={initialSpark} />);
  return { ref, setSpark: (id: string) => act(() => root.render(<Probe sparkId={id} />)) };
}

describe("isJobGone", () => {
  it("recognises the server's 404 text", () => {
    expect(isJobGone(new Error("Job not found (it may have been replaced by a newer one)"))).toBe(true);
    expect(isJobGone(new Error("HTTP 404"))).toBe(true);
    expect(isJobGone(new Error("HTTP 500"))).toBe(false);
  });
});

describe("useLauncherJob", () => {
  beforeEach(() => {
    readLauncherJob.mockReset();
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it("stops polling and explains when the job is gone", async () => {
    readLauncherJob.mockResolvedValueOnce({ job: job("j1"), lines: [], partial: "", nextSeq: 0, truncated: false });
    const { ref } = mount("s1");
    act(() => ref.api!.follow(job("j1")));
    await flush();
    readLauncherJob.mockRejectedValue(new Error("Job not found (it may have been replaced by a newer one)"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
    });
    expect(ref.api!.error).toBe(JOB_GONE_MESSAGE);
    expect(ref.api!.job?.status).toBe("detached");
    const calls = readLauncherJob.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(readLauncherJob.mock.calls.length).toBe(calls);
  });

  it("keeps retrying on other errors", async () => {
    readLauncherJob.mockResolvedValueOnce({ job: job("j1"), lines: [], partial: "", nextSeq: 0, truncated: false });
    const { ref } = mount("s1");
    act(() => ref.api!.follow(job("j1")));
    await flush();
    readLauncherJob.mockRejectedValue(new Error("HTTP 500"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2200);
    });
    expect(ref.api!.error).toBe("HTTP 500");
    expect(readLauncherJob.mock.calls.length).toBeGreaterThan(3);
  });

  it("drops the previous Spark's job when the Spark changes", async () => {
    readLauncherJob.mockResolvedValue({ job: job("j1"), lines: [{ seq: 1, text: "hello" }], partial: "", nextSeq: 1, truncated: false });
    const { ref, setSpark } = mount("s1");
    act(() => ref.api!.follow(job("j1")));
    await flush();
    expect(ref.api!.lines).toHaveLength(1);
    setSpark("s2");
    await flush();
    expect(ref.api!.job).toBeNull();
    expect(ref.api!.lines).toHaveLength(0);
  });
});
