import { describe, expect, it, vi } from "vitest";
import { act } from "react";
import type { MacRuntime, RuntimeControlTarget, RuntimeControlView } from "../../api/types";
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

const splash27b: RuntimeControlTarget = {
  name: "splash-27b",
  label: "Splash 27B",
  group: "splash",
  groupLabel: "Splash",
  models: [{ id: "incoai/Qwen3.8-27B-Splash", label: "Qwen3.8-27B" }],
  startable: true,
  stoppable: true,
};

function runtime(name: string, model: string | null, port: number | null = 8100): MacRuntime {
  return {
    name,
    label: name,
    role: "server",
    pid: 42,
    command: "python",
    port,
    model,
    state: "serving",
    detectedBy: "inventory",
  };
}

function view(partial: Partial<RuntimeControlView>): RuntimeControlView {
  return {
    state: "ready",
    reason: null,
    serving: [],
    targets: [target],
    ...partial,
  };
}

function captureIntervals() {
  const intervals: { id: number; delay: number; active: boolean; callback: () => Promise<void> | void }[] = [];
  vi.spyOn(window, "setInterval").mockImplementation(((handler, delay = 0) => {
    const id = intervals.length + 1;
    intervals.push({
      id,
      delay: Number(delay),
      active: true,
      callback: typeof handler === "function" ? handler as () => Promise<void> | void : () => {},
    });
    return id;
  }) as typeof window.setInterval);
  vi.spyOn(window, "clearInterval").mockImplementation((id) => {
    const interval = intervals.find((row) => row.id === id);
    if (interval) interval.active = false;
  });
  return {
    delays: () => intervals.filter((row) => row.active).map((row) => row.delay),
    async refresh(delay: number) {
      const interval = [...intervals].reverse().find((row) => row.active && row.delay === delay);
      if (!interval) throw new Error(`No active ${delay}ms status poll`);
      await act(async () => { await interval.callback(); });
    },
  };
}

describe("RuntimeLauncher", () => {
  it("does not present a previous operation's output as a new pending action", async () => {
    const load = vi.fn(async () => view({ operation: { id: "old", state: "complete", ok: true, output: "old private operation output" } }));
    let finish!: (value: RuntimeControlView) => void;
    const start = vi.fn(() => new Promise<RuntimeControlView>((resolve) => { finish = resolve; }));
    const { container } = render(<RuntimeLauncher sparkId="macbook" load={load} start={start} />);
    await flush();
    expect(container.querySelector('[role="log"]')?.textContent).toContain("old private operation output");
    act(() => container.querySelector<HTMLButtonElement>('[data-action="launch"]')!.click());
    expect(container.textContent).toContain("Working…");
    expect(container.querySelector('[role="log"]')?.textContent).not.toContain("old private operation output");
    await act(async () => finish(view({ busy: true, operation: { id: "new", state: "running", output: "new startup" } })));
    expect(container.querySelector('[role="log"]')?.textContent).toContain("new startup");
  });
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

  it("clears a successful-action notice when a later poll reports nothing serving", async () => {
    let refresh: (() => Promise<void>) | undefined;
    vi.spyOn(window, "setInterval").mockImplementation((handler) => {
      refresh = handler as () => Promise<void>;
      return 12345;
    });
    const load = vi.fn(async () => view({ serving: [] }));
    const start = vi.fn(async () => view({ ok: true, serving: [runtime("splash", target.models[0].id)] }));
    const { container } = render(<RuntimeLauncher sparkId="macbook" load={load} start={start} />);
    await flush();
    await act(async () => { (container.querySelector("button") as HTMLButtonElement).click(); });
    await flush();
    expect(container.textContent).toContain("The selected profile is serving.");
    await act(async () => { await refresh?.(); });
    await flush();
    expect(container.textContent).toContain("Nothing serving");
    expect(container.textContent).not.toContain("The selected profile is serving.");
    vi.restoreAllMocks();
  });

  it("keeps a lost start locked through GET busy and clears the transport error only after matching success", async () => {
    const intervals = captureIntervals();
    const load = vi.fn()
      .mockResolvedValueOnce(view({ serving: [] }))
      .mockResolvedValueOnce(view({
        busy: true,
        operation: { id: "op-2", state: "running", runtime: target.name, model: target.models[0].id, action: "start" },
        serving: [],
      }))
      .mockResolvedValueOnce(view({
        busy: false,
        operation: { id: "op-2", state: "complete", runtime: target.name, model: target.models[0].id, action: "start", ok: true, output: "runtime ready" },
        serving: [runtime("splash", target.models[0].id)],
      }));
    const start = vi.fn(async () => { throw new Error("POST fetch timed out"); });
    const { container } = render(<RuntimeLauncher sparkId="macbook" load={load} start={start} />);
    await flush();

    await act(async () => { (container.querySelector("button") as HTMLButtonElement).click(); });
    await flush();
    expect(start).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("POST fetch timed out");
    expect((container.querySelector("button") as HTMLButtonElement).textContent).toBe("Working…");
    expect([...container.querySelectorAll("select")].every((select) => select.disabled)).toBe(true);
    expect(intervals.delays()).toContain(2000);

    await intervals.refresh(2000);
    await flush();
    expect(load).toHaveBeenCalledTimes(2);
    expect(start).toHaveBeenCalledTimes(1);
    expect((container.querySelector("button") as HTMLButtonElement).textContent).toBe("Working…");
    expect([...container.querySelectorAll("select")].every((select) => select.disabled)).toBe(true);

    await intervals.refresh(2000);
    await flush();
    expect(load).toHaveBeenCalledTimes(3);
    expect(start).toHaveBeenCalledTimes(1);
    expect(container.querySelector("[data-testid='runtime-launcher-error']")).toBeNull();
    expect(container.textContent).toContain("runtime ready");
    expect(container.textContent).toContain("The selected profile is serving.");
    expect(container.querySelector("[data-action='stop']")?.textContent).toBe("Stop");
    vi.restoreAllMocks();
  });

  it("reconciles a resolved stop transport error and clears it after authoritative stop success", async () => {
    const intervals = captureIntervals();
    const load = vi.fn()
      .mockResolvedValueOnce(view({ serving: [runtime("splash", target.models[0].id)] }))
      .mockResolvedValueOnce(view({
        busy: true,
        operation: { id: "op-stop", state: "running", runtime: target.name, model: target.models[0].id, action: "stop" },
        serving: [runtime("splash", target.models[0].id)],
      }))
      .mockResolvedValueOnce(view({
        busy: false,
        operation: { id: "op-stop", state: "complete", runtime: target.name, model: target.models[0].id, action: "stop", ok: true, output: "stop completed" },
        serving: [],
      }));
    const stop = vi.fn(async () => view({
      state: "unavailable",
      reason: "fetch failed",
      error: "fetch failed",
      transportError: true,
      serving: null,
      targets: [],
    }));
    const { container } = render(<RuntimeLauncher sparkId="macbook" load={load} stop={stop} />);
    await flush();

    await act(async () => { (container.querySelector("button") as HTMLButtonElement).click(); });
    await flush();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("No response from the agent:");
    expect(container.textContent).toContain("Checking agent status");
    expect(container.textContent).toContain("Working…");
    expect(intervals.delays()).toContain(2000);

    await intervals.refresh(2000);
    await flush();
    expect(container.textContent).toContain("fetch failed");
    expect(container.textContent).toContain("Working…");
    expect(stop).toHaveBeenCalledTimes(1);

    await intervals.refresh(2000);
    await flush();
    expect(container.querySelector("[data-testid='runtime-launcher-error']")).toBeNull();
    expect(container.textContent).toContain("stop completed");
    expect(container.textContent).toContain("Stop command completed; the selected profile is no longer reported serving.");
    expect(container.querySelector("[data-action='launch']")?.textContent).toBe("Launch");
    expect(stop).toHaveBeenCalledTimes(1);
    vi.restoreAllMocks();
  });

  it("unlocks after an authoritative idle GET says a lost request was not received", async () => {
    const intervals = captureIntervals();
    const load = vi.fn()
      .mockResolvedValueOnce(view({ serving: [] }))
      .mockResolvedValueOnce(view({ serving: [] }));
    const start = vi.fn(async () => { throw new Error("connection reset"); });
    const { container } = render(<RuntimeLauncher sparkId="macbook" load={load} start={start} />);
    await flush();

    await act(async () => { (container.querySelector("button") as HTMLButtonElement).click(); });
    await flush();
    expect((container.querySelector("button") as HTMLButtonElement).textContent).toBe("Working…");
    expect([...container.querySelectorAll("select")].every((select) => select.disabled)).toBe(true);

    await intervals.refresh(2000);
    await flush();
    expect(container.textContent).toContain("Request outcome is unknown");
    expect(container.textContent).toContain("check serving status before retrying");
    expect(container.textContent).not.toContain("request was not received");
    expect(container.querySelector("[data-action='launch']")?.textContent).toBe("Launch");
    expect([...container.querySelectorAll("select")].every((select) => !select.disabled)).toBe(true);
    expect(start).toHaveBeenCalledTimes(1);
    vi.restoreAllMocks();
  });

  it("locks controls for a remote operation already running on page load", async () => {
    const intervals = captureIntervals();
    const load = vi.fn(async () => view({
      busy: true,
      operation: { id: "op-existing", state: "running", runtime: target.name, model: target.models[0].id, action: "start", output: "Waiting for exact-model readiness…" },
      serving: [],
    }));
    const start = vi.fn();
    const { container } = render(<RuntimeLauncher sparkId="macbook" load={load} start={start} />);
    await flush();

    const button = container.querySelector("button") as HTMLButtonElement;
    expect(button.textContent).toBe("Working…");
    expect(button.disabled).toBe(true);
    expect([...container.querySelectorAll("select")].every((select) => select.disabled)).toBe(true);
    expect(intervals.delays()).toContain(2000);
    expect(container.querySelector('[role="log"]')?.textContent).toContain("Waiting for exact-model readiness");

    await intervals.refresh(2000);
    expect(load).toHaveBeenCalledTimes(2);
    expect(start).not.toHaveBeenCalled();
    expect((container.querySelector("button") as HTMLButtonElement).disabled).toBe(true);
    vi.restoreAllMocks();
  });

  it("keeps an accepted operation visibly locked across a failed status poll", async () => {
    const intervals = captureIntervals();
    const operation = { id: "op-poll-loss", state: "running" as const, runtime: target.name, model: target.models[0].id, action: "start", output: "Starting selected profile…" };
    const load = vi.fn()
      .mockResolvedValueOnce(view({ busy: true, operation }))
      .mockResolvedValueOnce(view({ state: "unavailable", transportError: true, error: "Failed to fetch", serving: null, targets: [] }))
      .mockResolvedValueOnce(view({ busy: false, operation: { ...operation, state: "complete", ok: true }, serving: [runtime("splash", target.models[0].id)] }));
    const start = vi.fn();
    const { container } = render(<RuntimeLauncher sparkId="macbook" load={load} start={start} />);
    await flush();
    await intervals.refresh(2000);
    expect(container.textContent).toContain("Working…");
    expect(container.textContent).not.toContain("Unavailable");
    expect(container.querySelector('[role="log"]')?.textContent).toContain("Starting selected profile");
    expect((container.querySelector("button") as HTMLButtonElement).disabled).toBe(true);
    expect([...container.querySelectorAll("select")].every((select) => select.disabled)).toBe(true);
    await intervals.refresh(2000);
    await flush();
    expect(container.textContent).toContain("The selected profile is serving.");
    expect(container.querySelector("[data-action='stop']")?.textContent).toBe("Stop");
    expect(start).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it("shows a terminal operation error from polling and preserves it on later polls", async () => {
    const intervals = captureIntervals();
    const completed = view({
      busy: false,
      operation: { id: "op-failed", state: "complete", ok: false, error: "model failed to load", output: "worker exited 1" },
      serving: [],
    });
    const load = vi.fn()
      .mockResolvedValueOnce(view({
        busy: true,
        operation: { id: "op-failed", state: "running", runtime: target.name, model: target.models[0].id, action: "start" },
        serving: [],
      }))
      .mockResolvedValueOnce(completed)
      .mockResolvedValueOnce(completed);
    const start = vi.fn();
    const { container } = render(<RuntimeLauncher sparkId="macbook" load={load} start={start} />);
    await flush();

    await intervals.refresh(2000);
    await flush();
    expect(container.textContent).toContain("model failed to load");
    expect(container.textContent).toContain("worker exited 1");
    expect(container.textContent).not.toContain("The selected profile is serving.");

    await intervals.refresh(5000);
    await flush();
    expect(container.textContent).toContain("model failed to load");
    expect(container.textContent).toContain("worker exited 1");
    expect(start).not.toHaveBeenCalled();
    vi.restoreAllMocks();
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

  it("does not launch when control is ready but the serving probe is unavailable", async () => {
    const start = vi.fn();
    const { container } = render(
      <RuntimeLauncher
        sparkId="macbook"
        load={async () => view({ serving: null })}
        start={start}
      />,
    );
    await flush();

    expect(container.textContent).toContain("Not launching blind — serving status is unavailable.");
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
        load={async () => view({ serving: [runtime("splash-35b", "incoai/Qwen3.6-35B-A3B-Splash")] })}
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
      output: "missing weights under /models",
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
    expect(container.textContent).toContain("missing weights under /models");
    expect(container.textContent).toContain("Nothing serving");
    expect(container.textContent).not.toContain("started");
  });

  it("switches between same-group models using the fresh serving model, then stops a base-named runtime", async () => {
    const start = vi.fn(async () => view({
      ok: true,
      serving: [runtime("splash", "/models/incoai/Qwen3.8-27B-Splash/target", null)],
      targets: [target, splash27b],
    }));
    const stop = vi.fn(async () => view({ ok: true, serving: [], targets: [target, splash27b] }));
    const { container } = render(
      <RuntimeLauncher
        sparkId="macbook"
        agentOnline
        metricsRuntimes={[runtime("splash", "incoai/Qwen3.8-27B-Splash")]}
        load={async () => view({
          serving: [runtime("splash", "incoai/Qwen3.6-35B-A3B-Splash")],
          targets: [target, splash27b],
        })}
        start={start}
        stop={stop}
      />,
    );
    await flush();

    const profileSelect = container.querySelectorAll("select")[1] as HTMLSelectElement;
    act(() => {
      profileSelect.value = "splash-27b";
      profileSelect.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(container.textContent).toContain("incoai/Qwen3.8-27B-Splash");
    expect(container.textContent).toContain("Switching profiles stops the current model first.");
    const switchButton = container.querySelector("[data-action='switch']") as HTMLButtonElement;
    expect(switchButton?.textContent).toBe("Switch");

    await act(async () => {
      switchButton.click();
    });
    expect(start).toHaveBeenCalledWith("macbook", "splash-27b", "incoai/Qwen3.8-27B-Splash");
    expect(container.querySelector("[data-action='stop']")?.textContent).toBe("Stop");
    expect(container.textContent).toContain("is serving");

    const stopButton = container.querySelector("[data-action='stop']") as HTMLButtonElement;
    await act(async () => {
      stopButton.click();
    });
    expect(stop).toHaveBeenCalledWith("macbook", "splash-27b");
  });

  it("does not count the MTPLX mux as a heavy model serving", async () => {
    const mtplx: RuntimeControlTarget = {
      ...target,
      name: "mtplx-27b",
      label: "MTPLX 27B",
      group: "mtplx",
      groupLabel: "MTPLX",
      models: [{ id: "Youssofal/Qwen3.8-27B-MTPLX-Optimized-Speed", label: "Qwen3.8-27B" }],
    };
    const { container } = render(
      <RuntimeLauncher
        sparkId="macbook"
        load={async () => view({ serving: [runtime("mtplx-mux", null, 8200)], targets: [mtplx] })}
      />,
    );
    await flush();

    expect(container.querySelector("[data-action='launch']")?.textContent).toBe("Launch");
    expect(container.querySelector("[data-action='switch']")).toBeNull();
    expect(container.querySelector("[data-action='stop']")).toBeNull();
  });

  it("locks controls and prevents overlapping runtime actions while a launch is pending", async () => {
    let resolveStart: ((result: RuntimeControlView) => void) | undefined;
    const start = vi.fn(() => new Promise<RuntimeControlView>((resolve) => {
      resolveStart = resolve;
    }));
    const { container } = render(
      <RuntimeLauncher
        sparkId="macbook"
        load={async () => view({ serving: [] })}
        start={start}
      />,
    );
    await flush();

    const button = container.querySelector("[data-action='launch']") as HTMLButtonElement;
    act(() => button.click());
    await flush();
    expect(button.textContent).toBe("Working…");
    expect(button.disabled).toBe(true);
    expect(container.textContent).toContain("waiting for the serving probe");
    expect([...container.querySelectorAll("select")].every((select) => select.disabled)).toBe(true);

    act(() => button.click());
    expect(start).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveStart?.(view({ ok: true, serving: [] }));
    });
    expect(container.textContent).toContain("not confirmed serving yet");
    expect(container.textContent).not.toContain("The selected profile is serving.");
  });
});

it("does not apply Mac A's pending action result after navigating to Mac B", async () => {
  let finish!: (result: RuntimeControlView) => void;
  const start = () => new Promise<RuntimeControlView>((resolve) => { finish = resolve; });
  const bTarget = { ...target, name: "b-runtime", label: "B runtime", group: "b", groupLabel: "B", models: [] };
  const load = async (id: string) => view({ targets: id === "a" ? [target] : [bTarget], serving: [] });
  const { container, root } = render(<RuntimeLauncher sparkId="a" load={load} start={start} />);
  await flush();
  act(() => { (container.querySelector('[data-action="launch"]') as HTMLButtonElement).click(); });
  act(() => root.render(<RuntimeLauncher sparkId="b" load={load} start={start} />));
  await flush();
  expect(container.textContent).toContain("B runtime");
  finish(view({ targets: [target], serving: [] }));
  await flush();
  expect(container.textContent).toContain("B runtime");
  expect(container.textContent).not.toContain("Splash 35B");
});

it("preserves explicitly unknown inventory instead of reusing an old empty status", async () => {
  const load = async () => view({ serving: [] });
  const { container, root } = render(<RuntimeLauncher sparkId="fixture" load={load} metricsRuntimes={[]} agentOnline />);
  await flush();
  expect(container.querySelector('[data-action="launch"]')).not.toBeNull();
  act(() => root.render(<RuntimeLauncher sparkId="fixture" load={load} metricsRuntimes={null} agentOnline />));
  await flush();
  expect(container.textContent).toContain("Serving status unavailable");
  expect(container.textContent).not.toContain("Nothing serving");
  expect(container.querySelector('[data-action="launch"]')).toBeNull();
});
