import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flush, render } from "../../testing/render";
import { ServiceCard, type ServiceCardProps } from "./ServiceCard";

const NOW = 1_800_000_000_000;

function props(overrides: Partial<ServiceCardProps> = {}): ServiceCardProps {
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
    polledAt: NOW - 30_000,
    onStart: vi.fn(),
    onStop: vi.fn(),
    onSwitch: vi.fn(),
    ...overrides,
  };
}

function button(container: HTMLElement, ariaLabel: string): HTMLButtonElement | null {
  return container.querySelector(`button[aria-label="${ariaLabel}"]`);
}

describe("ServiceCard", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders header, engine, model, port, footprint, active, and relative polled time", async () => {
    const { container } = render(<ServiceCard {...props()} />);
    await flush();
    const text = container.textContent ?? "";
    expect(text).toContain("llm-tp1");
    expect(text).toContain("sglang v1.2.0");
    expect(text).toContain("qwen3.8-27b");
    expect(text).toContain("8080");
    expect(text).toContain("110.0 GB"); // 112640 MB
    expect(text).toContain("ACTIVE");
    expect(text).toContain("30s ago");
  });

  it("shows Stop only when running, Start only when stopped, all three when wedged", async () => {
    const running = render(<ServiceCard {...props({ status: "running" })} />);
    await flush();
    expect(button(running.container, "Stop llm-tp1")).not.toBeNull();
    expect(button(running.container, "Start llm-tp1")).toBeNull();
    expect(button(running.container, "Switch llm-tp1")).toBeNull();

    const stopped = render(<ServiceCard {...props({ status: "stopped" })} />);
    await flush();
    expect(button(stopped.container, "Start llm-tp1")).not.toBeNull();
    expect(button(stopped.container, "Stop llm-tp1")).toBeNull();
    expect(button(stopped.container, "Switch llm-tp1")).toBeNull();

    const wedged = render(<ServiceCard {...props({ status: "wedged" })} />);
    await flush();
    expect(button(wedged.container, "Start llm-tp1")).not.toBeNull();
    expect(button(wedged.container, "Stop llm-tp1")).not.toBeNull();
    expect(button(wedged.container, "Switch llm-tp1")).not.toBeNull();
  });

  it.each(["running", "stopped", "loading", "wedged", "unknown"] as const)(
    "renders the %s status badge",
    (status) => {
      const { container } = render(<ServiceCard {...props({ status })} />);
      expect(container.textContent).toContain(status);
    }
  );

  it.each(["llm", "image", "video", "tts", "stt", "voice", "other", ""] as const)(
    "renders the kind badge for kind %j (empty kind falls back to other)",
    (kind) => {
      const { container } = render(<ServiceCard {...props({ kind })} />);
      expect(container.textContent).toContain(kind === "" ? "other" : kind);
    }
  );

  it("renders an em-dash for a null model and falls back to the bare engine name", async () => {
    const { container } = render(<ServiceCard {...props({ modelId: null, engineVersion: null })} />);
    await flush();
    const text = container.textContent ?? "";
    expect(text).toContain("—");
    expect(text).toContain("sglang");
    expect(text).not.toContain("v1.2.0");
  });

  it("fires Start / Stop / Switch callbacks", async () => {
    const p = props({ status: "wedged" });
    const { container } = render(<ServiceCard {...p} />);
    await flush();
    act(() => {
      button(container, "Start llm-tp1")?.click();
      button(container, "Stop llm-tp1")?.click();
      button(container, "Switch llm-tp1")?.click();
    });
    expect(p.onStart).toHaveBeenCalledTimes(1);
    expect(p.onStop).toHaveBeenCalledTimes(1);
    expect(p.onSwitch).toHaveBeenCalledTimes(1);
  });
});
