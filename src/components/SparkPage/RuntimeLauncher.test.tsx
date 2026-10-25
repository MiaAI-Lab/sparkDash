import { describe, expect, it, vi } from "vitest";
import { act } from "react";
import type { RuntimeControlTarget, RuntimeControlView } from "../../api/types";
import { render, flush } from "../../testing/render";
import { RuntimeLauncher } from "./RuntimeLauncher";

const target: RuntimeControlTarget = {
  name: "splash-35b",
  label: "Splash 35B",
  group: "splash",
  groupLabel: "Splash",
  models: [{ id: "incoai/Qwen3.6-35B-A3B-Splash", label: "Qwen3.6-35B-A3B" }],
  startable: true,
  stoppable: true,
};

function view(partial: Partial<RuntimeControlView>): RuntimeControlView {
  return {
    state: "ready",
    reason: null,
    serving: [],
    targets: [target],
    ...partial,
  };
}

describe("RuntimeLauncher", () => {
  it("does not start a runtime while checking, and hides the button when control is unavailable", async () => {
    const start = vi.fn();
    const { container } = render(
      <RuntimeLauncher
        sparkId="macbook"
        load={async () => view({ state: "unavailable", reason: "SPARKDASH_MAC_CONTROL_TOKEN is not set", serving: null, targets: [] })}
        start={start}
      />,
    );
    expect(start).not.toHaveBeenCalled();
    expect(container.querySelector("[data-action='launch']")).toBeNull();
    await flush();
    expect(container.textContent).toContain("Unavailable — SPARKDASH_MAC_CONTROL_TOKEN is not set");
    expect(container.querySelector("[data-action='launch']")).toBeNull();
    expect(container.querySelector("[data-action='stop']")).toBeNull();
    expect(start).not.toHaveBeenCalled();
  });

  it("shows permission denied instead of a launch button", async () => {
    const start = vi.fn();
    const { container } = render(
      <RuntimeLauncher
        sparkId="macbook"
        load={async () => view({ state: "denied", reason: "control token rejected", serving: null, targets: [] })}
        start={start}
      />,
    );
    await flush();
    expect(container.textContent).toContain("Permission denied — control token rejected");
    expect(container.querySelector("button")).toBeNull();
    expect(start).not.toHaveBeenCalled();
  });

  it("reflects the live probe and uses stop, not a success-styled launch button", async () => {
    const start = vi.fn();
    const { container } = render(
      <RuntimeLauncher
        sparkId="macbook"
        agentOnline
        metricsRuntimes={[{
          name: "splash-35b",
          label: "Splash 35B",
          role: "server",
          pid: 42,
          command: "splash",
          port: 8100,
          model: "incoai/Qwen3.6-35B-A3B-Splash",
          state: "serving",
          detectedBy: "inventory",
        }]}
        load={async () => view({ serving: [] })}
        start={start}
      />,
    );
    await flush();
    expect(container.textContent).toContain("incoai/Qwen3.6-35B-A3B-Splash (:8100)");
    const button = container.querySelector("[data-action='stop']");
    expect(button).not.toBeNull();
    expect(button?.className).not.toContain("bg-success");
    expect(button?.className).not.toContain("text-success");
    expect(container.querySelector("[data-action='launch']")).toBeNull();
    expect(start).not.toHaveBeenCalled();
  });

  it("renders the action's real error and does not claim the runtime started", async () => {
    const start = vi.fn(async () => view({
      ok: false,
      error: "splash: model is not installed",
      serving: [],
    }));
    const { container } = render(
      <RuntimeLauncher
        sparkId="macbook"
        agentOnline
        metricsRuntimes={[]}
        load={async () => view({ serving: [] })}
        start={start}
      />,
    );
    await flush();
    const button = container.querySelector("[data-action='launch']") as HTMLButtonElement;
    expect(button).not.toBeNull();
    expect(button.className).not.toContain("bg-success");
    await act(async () => {
      button.click();
    });
    expect(start).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledWith("macbook", "splash-35b", "incoai/Qwen3.6-35B-A3B-Splash");
    expect(container.textContent).toContain("splash: model is not installed");
    expect(container.textContent).toContain("Nothing serving");
    expect(container.textContent).not.toContain("started");
  });
});
