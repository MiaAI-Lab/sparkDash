import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { flush, render } from "../../testing/render";
import type {
  MemoryBudget as MemoryBudgetType,
  ServiceInstance,
  VersionInfo,
} from "../../../shared/types";
import { ServiceManagerPage } from "./ServiceManagerPage";

const NOW = 1_800_000_000_000;

function service(overrides: Partial<ServiceInstance> = {}): ServiceInstance {
  return {
    name: "llm-tp1",
    kind: "llm",
    engine: "sglang",
    port: 8080,
    status: "running",
    modelId: "qwen3.8-27b",
    engineVersion: "v1.2.0",
    footprintMB: 112_640,
    active: true,
    polledAt: NOW,
    ...overrides,
  };
}

function memory(overrides: Partial<MemoryBudgetType> = {}): MemoryBudgetType {
  return {
    nodeId: "gx10-1c2c",
    totalMB: 131_072,
    usedMB: 110_000,
    freeMB: 21_072,
    servicesUsedMB: 112_640,
    otherUsedMB: 17_432,
    services: [{ name: "llm-tp1", kind: "llm", footprintMB: 112_640, running: true, needed: true }],
    makeRoom: [{ serviceName: "llm-tp2", freesMB: 102_400, reason: "stoppable" }],
    needMakeRoom: true,
    polledAt: NOW,
    ...overrides,
  };
}

function version(overrides: Partial<VersionInfo> = {}): VersionInfo {
  return {
    serviceName: "llm-tp1",
    kind: "llm",
    engine: "sglang",
    engineVersion: "v1.2.0",
    modelId: "qwen3.8-27b",
    modelPath: "RadixArk/Qwen3.8-27B-NVFP4",
    modelRevision: null,
    quantization: "nvfp4",
    contextLength: 262_144,
    memFraction: 0.9,
    tpSize: 1,
    port: 8080,
    state: "running",
    polledAt: NOW,
    ...overrides,
  };
}

function button(container: HTMLElement, ariaLabel: string): HTMLButtonElement | null {
  return container.querySelector(`button[aria-label="${ariaLabel}"]`);
}

describe("ServiceManagerPage", () => {
  it("renders header, memory budget, make-room plan, services, and versions", async () => {
    const { container } = render(
      <ServiceManagerPage
        nodeId="gx10-1c2c"
        nodeName="Node 1"
        services={[
          service(),
          service({
            name: "image-sd",
            kind: "image",
            engine: "comfyui",
            port: 8188,
            status: "stopped",
            modelId: null,
            engineVersion: null,
            active: false,
            footprintMB: 20_480,
          }),
        ]}
        memory={memory()}
        versions={[version()]}
        onStart={vi.fn()}
        onStop={vi.fn()}
        onSwitch={vi.fn()}
      />
    );
    await flush();
    const text = container.textContent ?? "";
    // header
    expect(text).toContain("Service Manager");
    expect(text).toContain("Node 1");
    expect(text).toContain("gx10-1c2c");
    // memory budget
    expect(text).toContain("Memory Budget");
    expect(text).toContain("128.0 GB"); // total
    expect(text).toContain("Make room needed");
    expect(text).toContain("stoppable");
    expect(text).toContain("+100.0 GB"); // 102400 MB freed
    // services
    expect(text).toContain("llm-tp1");
    expect(text).toContain("image-sd");
    expect(text).toContain("comfyui");
    expect(text).toContain("8188");
    // versions
    expect(text).toContain("RadixArk/Qwen3.8-27B-NVFP4");
    expect(text).toContain("262,144");
    expect(text).toContain("0.9");
    expect(text).toContain(":8080");
  });

  it("shows empty states for no services and no versions", async () => {
    const { container } = render(
      <ServiceManagerPage
        nodeId="gx10-1c2c"
        nodeName="Node 1"
        services={[]}
        memory={memory({ needMakeRoom: false, makeRoom: [], services: [] })}
        versions={[]}
        onStart={vi.fn()}
        onStop={vi.fn()}
        onSwitch={vi.fn()}
      />
    );
    await flush();
    const text = container.textContent ?? "";
    expect(text).toContain("Service Manager");
    expect(text).toContain("No services");
    expect(text).toContain("No version info");
    expect(text).toContain("OK");
    expect(text).not.toContain("Make room needed");
    expect(text).not.toContain("Make-room plan");
    expect(text).not.toContain("(llm)"); // no service rows in the budget panel
  });

  it("routes start/stop/switch actions to the clicked service", async () => {
    const onStart = vi.fn();
    const onStop = vi.fn();
    const onSwitch = vi.fn();
    const { container } = render(
      <ServiceManagerPage
        nodeId="gx10-1c2c"
        nodeName="Node 1"
        services={[
          service(), // running -> Stop
          service({
            name: "image-sd",
            kind: "image",
            port: 8188,
            status: "loading",
            active: false,
            modelId: null,
            engineVersion: null,
          }),
        ]}
        memory={memory()}
        versions={[]}
        onStart={onStart}
        onStop={onStop}
        onSwitch={onSwitch}
      />
    );
    await flush();
    act(() => {
      button(container, "Start image-sd")?.click();
    });
    expect(onStart).toHaveBeenCalledWith("image-sd");
    act(() => {
      button(container, "Stop llm-tp1")?.click();
    });
    expect(onStop).toHaveBeenCalledWith("llm-tp1");
    act(() => {
      button(container, "Switch image-sd")?.click();
    });
    expect(onSwitch).toHaveBeenCalledWith("image-sd");
  });
});
