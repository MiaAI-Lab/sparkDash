import { describe, expect, it } from "vitest";
import { OverviewPage } from "./OverviewPage";
import { render } from "../../testing/render";
import type { SparkSnapshot } from "../../api/types";

/** The RTX PRO 6000 host as the live instance reported it. */
function host(overrides: { cpuTemp?: number; kind?: "spark" | "host" } = {}): SparkSnapshot {
  return {
    id: "rtx-pro-6000",
    name: "RTX PRO 6000",
    kind: overrides.kind ?? "host",
    online: true,
    uptime: 1000,
    disabledDevices: [],
    disabledInterfaces: [],
    llmPort: 30000,
    llmPorts: [30000],
    metrics: {
      gpu: {
        usage: 37,
        temperature: 44,
        vram: { used: 90_000, total: 97_887, available: 7_887, percentage: 92 },
        power: { draw: 80, limit: 600 },
      },
      cpu: { temperature: overrides.cpuTemp ?? 0 },
      ram: { used: 40_000, total: 128_000 },
      storage: [
        { label: "/", device: "nvme1n1p2", used: 836_010, total: 1_875_626, percentage: 44.6 },
      ],
      llm: [{ available: true, backend: "sglang", modelId: "qwen38-exl3-ple8", generationTps: 0, prefillTps: 0 }],
    },
  } as unknown as SparkSnapshot;
}

/** Bar labels in render order. */
function barLabels(container: HTMLElement): string[] {
  return [...container.querySelectorAll(".space-y-1 > div:first-child > span:first-child")].map(
    (el) => el.textContent ?? ""
  );
}

describe("Overview card", () => {
  it("names each bar for what it measures", () => {
    const { container } = render(<OverviewPage sparks={[host({ cpuTemp: 51 })]} />);
    expect(barLabels(container)).toEqual(["VRAM", "RAM", "GPU temp", "CPU temp", "GPU util"]);
  });

  it("calls the temperature bar GPU temp even without a CPU sensor", () => {
    // A GB10 has no CPU package sensor; this used to read "Temperature".
    const { container } = render(<OverviewPage sparks={[host({ kind: "spark" })]} />);
    expect(barLabels(container)).toEqual(["VRAM", "GPU temp", "GPU util"]);
  });

  it("fits a 1.8 TB root disk in the Storage mini-stat", () => {
    const { container } = render(<OverviewPage sparks={[host()]} />);
    const label = [...container.querySelectorAll("span")].find((el) => el.textContent === "Storage");
    const value = label?.nextElementSibling as HTMLElement | null;
    expect(value?.textContent).toBe("816 GB / 1.8 TB");
    expect(value?.title).toBe("816.4 GB of 1831.7 GB used (45%)");
  });

  it("calls SGLang by its name", () => {
    const { container } = render(<OverviewPage sparks={[host()]} />);
    expect(container.textContent).toContain("SGLang");
    expect(container.textContent).not.toContain("sgLang");
  });
});
