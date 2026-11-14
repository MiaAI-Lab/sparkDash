import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SparkCard } from "./SparkCard";
import { invalidateLaunchers } from "../../hooks/launcherCache";
import { makeSpark } from "../../testing/fixtures";
import { render } from "../../testing/render";

vi.mock("../../api/client", () => ({
  fetchLaunchers: vi.fn().mockResolvedValue({ launchers: [], statuses: {} }),
  runLauncher: vi.fn(),
  wakeSpark: vi.fn(),
}));

const flush = () => act(async () => {
  await Promise.resolve();
  await Promise.resolve();
});

function busyStandalone(id: string, processName: string) {
  const spark = makeSpark(id);
  Object.assign(spark, {
    role: "standalone",
    online: true,
    platform: "linux",
  });
  const gpu = spark.metrics.gpu!;
  spark.metrics.llm = [{ ...spark.metrics.llm[0], available: false }];
  spark.metrics.gpu = {
    ...gpu,
    usage: 94,
    vram: { ...gpu.vram, used: 92_160, total: 128_000, percentage: 72 },
    processes: [{ pid: 42, name: processName, vramMB: 90_000 }],
  };
  return spark;
}

describe("SparkCard worker-role discoverability hint", () => {
  beforeEach(() => {
    for (const id of ["rank1-proc", "rank1-sib", "solo-flare", "head-node"]) {
      invalidateLaunchers(id);
    }
  });

  it("hints at the Worker role when GPU is held by a multi-rank engine process", async () => {
    const { container } = render(
      <SparkCard spark={busyStandalone("rank1-proc", "tensorfold")} temperatureUnit="celsius" />,
    );
    await flush();
    expect(container.textContent).toContain("GPU is in use");
    expect(container.querySelector(".ov-launch__hint--worker")?.textContent).toMatch(/Worker/);
  });

  it("hints at the Worker role when a sibling Spark is serving and GPU is held by another process", async () => {
    const { container } = render(
      <SparkCard spark={busyStandalone("rank1-sib", "python3")} siblingServing temperatureUnit="celsius" />,
    );
    await flush();
    expect(container.textContent).toContain("GPU is in use");
    expect(container.querySelector(".ov-launch__hint--worker")?.textContent).toMatch(/Worker/);
  });

  it("omits the worker hint when standalone GPU is held by an unrelated process without sibling engines", async () => {
    const { container } = render(
      <SparkCard spark={busyStandalone("solo-flare", "flare")} temperatureUnit="celsius" />,
    );
    await flush();
    expect(container.textContent).toContain("GPU is in use");
    expect(container.querySelector(".ov-launch__hint--worker")).toBeNull();
  });

  it("never suggests marking a head node as a worker", async () => {
    const head = busyStandalone("head-node", "tensorfold");
    head.role = "head";
    const { container } = render(
      <SparkCard spark={head} siblingServing temperatureUnit="celsius" />,
    );
    await flush();
    expect(container.textContent).toContain("GPU is in use");
    expect(container.querySelector(".ov-launch__hint--worker")).toBeNull();
  });
});
