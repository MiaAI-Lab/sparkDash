import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchGpuClock, fetchSparks, resetFleetGpuClock, setFleetGpuClock } from "../api/client";
import type { FleetGpuClockResult, GpuClockPersistKind, GpuClockStatus, SparkConfig } from "../api/types";
import { FleetGpuClock, type FleetGpuClockApi } from "./FleetGpuClock";
import { cleanupRenders, flush, render } from "../testing/render";

vi.mock("../api/client", () => ({
  fetchSparks: vi.fn(),
  fetchGpuClock: vi.fn(),
  setFleetGpuClock: vi.fn(),
  resetFleetGpuClock: vi.fn(),
}));

const listApi = vi.mocked(fetchSparks);
const statusApi = vi.mocked(fetchGpuClock);
const setApi = vi.mocked(setFleetGpuClock);
const resetApi = vi.mocked(resetFleetGpuClock);

const FLEET = {
  sparks: [
    { id: "spark1", kind: "spark" },
    { id: "spark2", kind: "spark" },
    { id: "desk", kind: "host" },
  ] as SparkConfig[],
};

/** A unit that can cap, with the boot hook it would use. */
const ready = (
  capMHz: number | null,
  persistKind: GpuClockPersistKind = "unit",
): GpuClockStatus => ({
  supported: true,
  hwMaxMHz: 3003,
  capMHz,
  sudo: "yes",
  persistKind,
  service: { installed: false, clocks: null, enabled: null, active: null },
  cron: { installed: false, clocks: null },
});

/** What the fleet route answers: `success` only when every unit took the request. */
const done = (results: FleetGpuClockResult[]) => ({ success: results.every((r) => r.ok), results });

const byText = (c: HTMLElement, text: string) => {
  const button = [...c.querySelectorAll("button")].find((el) => el.textContent?.includes(text));
  if (!button) throw new Error(`no button matching ${text}`);
  return button;
};

const status = (c: HTMLElement) => c.querySelector('[role="status"]');

const settle = async () => {
  for (let i = 0; i < 6; i += 1) await flush();
};

const click = async (el: HTMLElement) => {
  el.click();
  await settle();
};

/**
 * Runs out the per-unit read deadlines on fake timers: the fleet list, the first
 * try and the retry each race their own deadline.
 */
const outwait = async (ms: number) => {
  for (let i = 0; i < 3; i += 1) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
    await settle();
  }
};

/** A read that answers when the test says so. */
// ES2022 target: `Promise.withResolvers` (ES2024) is not available here.
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
};

/** A read that never answers — a Spark behind a dead SSH connection. */
const hang = () => new Promise<never>(() => {});

/** Save's side of the contract: run the row's pending pick. */
const applyPicked = async (ref: { current: FleetGpuClockApi | null }) => {
  let ok = false;
  await act(async () => {
    ok = await ref.current!.apply();
  });
  await settle();
  return ok;
};

describe("FleetGpuClock", () => {
  beforeEach(() => {
    listApi.mockReset().mockResolvedValue(FLEET);
    statusApi.mockReset().mockResolvedValue(ready(2100));
    setApi.mockReset();
    resetApi.mockReset();
  });
  afterEach(() => {
    cleanupRenders();
    vi.useRealTimers();
  });

  it("marks the cap every Spark shares, and a pick only selects until Save applies it", async () => {
    const ref = { current: null as FleetGpuClockApi | null };
    const told: boolean[] = [];
    const { container } = render(
      <FleetGpuClock apiRef={ref} onPendingChange={(pending) => told.push(pending)} />,
    );
    await settle();

    expect(container.querySelector('[data-testid="fleet-now"]')!.textContent).toContain("Now: capped at 2100 MHz on 2 units");
    expect(byText(container, "2100 MHz").className).toContain("is-current");
    expect(ref.current!.pending()).toBe(false);
    // Hosts are not asked at all: a PC has no clock to cap.
    expect(statusApi).toHaveBeenCalledWith("spark1");
    expect(statusApi).toHaveBeenCalledWith("spark2");
    expect(statusApi).not.toHaveBeenCalledWith("desk");

    setApi.mockResolvedValue(done([
      { id: "spark1", ok: true, capMHz: 1800, persistKind: "unit" },
      { id: "spark2", ok: true, capMHz: 1800, persistKind: "unit" },
    ]));
    await click(byText(container, "1800 MHz"));

    // The pick is a selection: nothing has been sent, and Save is what runs it.
    expect(setApi).not.toHaveBeenCalled();
    expect(ref.current!.pending()).toBe(true);
    expect(told.at(-1)).toBe(true);
    expect(byText(container, "1800 MHz").className).toContain("is-picked");
    expect(byText(container, "2100 MHz").className).toContain("is-current");

    expect(await applyPicked(ref)).toBe(true);

    // Both units reported a hook, so keeping the cap is the default, not an opt-in.
    expect(setApi).toHaveBeenCalledWith(1800, true);
    const msg = status(container)!;
    expect(msg.textContent).toContain("Capped at 1800 MHz — 2 of 2 units");
    expect(msg.textContent).toContain("kept after reboot");
    expect(msg.className).not.toContain("is-err");
    // Applied: the pick is spent, and choosing the fleet's own state again is a no-op.
    expect(ref.current!.pending()).toBe(false);
  });

  it("marks nothing when the fleet is on different caps", async () => {
    statusApi.mockImplementation(async (id) => ready(id === "spark1" ? 1800 : null));
    const { container } = render(<FleetGpuClock />);
    await settle();

    expect(container.querySelector('[data-testid="fleet-now"]')!.textContent).toContain("Now: mixed — 1800 MHz, full capacity");
    expect(container.querySelectorAll(".is-current")).toHaveLength(0);
  });

  it("marks Full capacity when no cap is applied, and clears the caps only when applied", async () => {
    statusApi.mockResolvedValue(ready(null));
    const ref = { current: null as FleetGpuClockApi | null };
    resetApi.mockResolvedValue(done([
      { id: "spark1", ok: true, capMHz: null, persistKind: "none" },
      { id: "spark2", ok: true, capMHz: null, persistKind: "none" },
    ]));
    const { container } = render(<FleetGpuClock apiRef={ref} />);
    await settle();

    expect(byText(container, "Full capacity").className).toContain("is-current");

    await click(byText(container, "Full capacity"));
    expect(resetApi).not.toHaveBeenCalled();

    expect(await applyPicked(ref)).toBe(true);

    expect(resetApi).toHaveBeenCalled();
    expect(setApi).not.toHaveBeenCalled();
    expect(status(container)!.textContent).toContain("Full capacity — 2 of 2 units");
    // The tick defaulted on (every unit can keep a cap), but removing the cap keeps nothing.
    expect(status(container)!.textContent).not.toContain("kept");
  });

  it("reports a unit that cannot take a cap as skipped, not as an error", async () => {
    setApi.mockResolvedValue(done([
      { id: "spark1", ok: true, capMHz: 1800, persistKind: "unit" },
      { id: "spark2", ok: true, supported: false, reason: "nvidia-smi was not found on this unit" },
    ]));
    const ref = { current: null as FleetGpuClockApi | null };
    const { container } = render(<FleetGpuClock apiRef={ref} />);
    await settle();

    await click(byText(container, "1800 MHz"));
    await applyPicked(ref);

    const msg = status(container)!;
    expect(msg.textContent).toContain("1 of 2 units, 1 skipped");
    expect(msg.className).not.toContain("is-err");
  });

  it("defaults Keep after reboot off when no unit has a boot hook to use", async () => {
    statusApi.mockResolvedValue(ready(2100, "none"));
    setApi.mockResolvedValue(done([{ id: "spark1", ok: true, capMHz: 1800, persistKind: "none" }]));
    const ref = { current: null as FleetGpuClockApi | null };
    const { container } = render(<FleetGpuClock apiRef={ref} />);
    await settle();

    // Neither a root shell for the boot service nor cron for an @reboot job: the
    // row must not default to an option that is going to be refused.
    expect((container.querySelector('input[type="checkbox"]') as HTMLInputElement).checked).toBe(false);

    await click(byText(container, "1800 MHz"));
    await applyPicked(ref);

    expect(setApi).toHaveBeenCalledWith(1800, false);
  });

  it("defaults it on where the units keep the cap with their own cron job", async () => {
    // The @reboot job needs only the narrow nvidia-smi rule, so a Spark that has
    // no root shell still keeps its cap — and the row says which way.
    statusApi.mockResolvedValue(ready(2100, "cron"));
    setApi.mockResolvedValue(done([
      { id: "spark1", ok: true, capMHz: 1800, persistKind: "cron" },
      { id: "spark2", ok: true, capMHz: 1800, persistKind: "cron" },
    ]));
    const ref = { current: null as FleetGpuClockApi | null };
    const { container } = render(<FleetGpuClock apiRef={ref} />);
    await settle();

    expect((container.querySelector('input[type="checkbox"]') as HTMLInputElement).checked).toBe(true);

    await click(byText(container, "1800 MHz"));
    await applyPicked(ref);

    expect(setApi).toHaveBeenCalledWith(1800, true);
    expect(status(container)!.textContent).toContain("kept by an @reboot cron job on each unit");
  });

  it("names the hook per unit when one Spark keeps the cap differently from another", async () => {
    statusApi.mockResolvedValue(ready(2100, "cron"));
    setApi.mockResolvedValue(done([
      { id: "spark1", ok: true, capMHz: 1800, persistKind: "unit" },
      { id: "spark2", ok: true, capMHz: 1800, persistKind: "cron" },
    ]));
    const ref = { current: null as FleetGpuClockApi | null };
    const { container } = render(<FleetGpuClock apiRef={ref} />);
    await settle();

    await click(byText(container, "1800 MHz"));
    await applyPicked(ref);

    expect(status(container)!.textContent).toContain(
      "Capped at 1800 MHz — 2 of 2 units — kept after reboot (boot service or @reboot job, per unit)",
    );
  });

  it("says nothing changed when every unit refuses, names the reason once and the way out", async () => {
    const refusal =
      "keeping the cap after reboot needs passwordless sudo for the system service (NOPASSWD: ALL) or a running cron service for a @reboot job, and this unit offers neither";
    setApi.mockResolvedValue(done([
      { id: "spark1", ok: false, error: refusal },
      { id: "spark2", ok: false, error: refusal },
    ]));
    const ref = { current: null as FleetGpuClockApi | null };
    const { container } = render(<FleetGpuClock apiRef={ref} />);
    await settle();

    await click(byText(container, "1800 MHz"));
    expect(await applyPicked(ref)).toBe(false);

    const msg = status(container)!;
    expect(msg.textContent).toContain("Nothing changed — 0 of 2 units capped");
    expect(msg.textContent).not.toContain("Capped at 1800 MHz");
    // Grouped by reason: named once with both units, not twice.
    expect(msg.textContent?.match(/needs passwordless sudo/g)).toHaveLength(1);
    expect(msg.textContent).toContain("spark1, spark2:");
    expect(msg.textContent).toContain("Untick “Keep after reboot”");
    expect(msg.className).toContain("is-err");
    // Refused everywhere: the pick is still there to retry, not silently dropped.
    expect(ref.current!.pending()).toBe(true);
  });

  it("keeps the box usable while a read is unknown, but not when the fleet is known to refuse", async () => {
    statusApi.mockResolvedValue(ready(2100, "none"));
    const narrow = { current: null as FleetGpuClockApi | null };
    const one = render(<FleetGpuClock apiRef={narrow} />);
    await settle();
    // Every unit answered, and the answer is "no boot hook here".
    expect((one.container.querySelector('input[type="checkbox"]') as HTMLInputElement).disabled).toBe(true);
    expect(one.container.textContent).toContain("The cap applies until the next reboot");
    cleanupRenders();

    statusApi.mockImplementation(() => hang());
    setApi.mockResolvedValue(done([{ id: "spark1", ok: true, capMHz: 1800, persistKind: "unit" }]));
    const ref = { current: null as FleetGpuClockApi | null };
    vi.useFakeTimers();
    const { container } = render(<FleetGpuClock apiRef={ref} readTimeoutMs={20} />);
    await outwait(20);
    // Nothing read: unknown is not "refused", so the box stays available.
    expect((container.querySelector('input[type="checkbox"]') as HTMLInputElement).disabled).toBe(false);
  });

  it("surfaces a refused request", async () => {
    setApi.mockRejectedValue(new Error("Too many GPU clock changes, try again in a minute"));
    const ref = { current: null as FleetGpuClockApi | null };
    const { container } = render(<FleetGpuClock apiRef={ref} />);
    await settle();

    await click(byText(container, "2300 MHz"));
    expect(await applyPicked(ref)).toBe(false);

    const msg = status(container)!;
    expect(msg.textContent).toContain("Too many GPU clock changes");
    expect(msg.className).toContain("is-err");
  });

  it("marks what the units that answered report when one read hangs, and counts the other", async () => {
    statusApi.mockImplementation(async (id) =>
      id === "spark2" ? hang() : ready(2100),
    );
    vi.useFakeTimers();
    const { container } = render(<FleetGpuClock readTimeoutMs={20} />);
    await outwait(20);

    expect(container.querySelector('[data-testid="fleet-now"]')!.textContent).toContain(
      "Now: capped at 2100 MHz on 1 unit, 1 unreadable",
    );
    expect(byText(container, "2100 MHz").className).toContain("is-current");
  });

  it("leaves the states usable, not 'Reading the fleet…', when every read hangs", async () => {
    statusApi.mockImplementation(() => hang());
    vi.useFakeTimers();
    const { container } = render(<FleetGpuClock readTimeoutMs={20} />);
    await outwait(20);

    expect(byText(container, "2400 MHz").disabled).toBe(false);
    expect(container.querySelector('[data-testid="fleet-now"]')!.textContent).toContain(
      "No unit reports its clock right now",
    );
  });

  it("keeps an unticked Keep after reboot unticked when the fleet is read again after an apply", async () => {
    setApi.mockResolvedValue(done([
      { id: "spark1", ok: true, capMHz: 1800, persistKind: "none" },
      { id: "spark2", ok: true, capMHz: 1800, persistKind: "none" },
    ]));
    const ref = { current: null as FleetGpuClockApi | null };
    const { container } = render(<FleetGpuClock apiRef={ref} />);
    await settle();
    const box = container.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(box.checked).toBe(true);

    await click(box);
    expect(box.checked).toBe(false);
    await click(byText(container, "1800 MHz"));
    statusApi.mockResolvedValue(ready(1800));
    expect(await applyPicked(ref)).toBe(true);
    expect(setApi).toHaveBeenLastCalledWith(1800, false);

    // The read after the apply finds every unit able to keep a cap again; the
    // user's choice still stands, or the next Save would install boot hooks.
    expect(container.querySelector('[data-testid="fleet-now"]')!.textContent).toContain("Now: capped at 1800 MHz on 2 units");
    expect(box.checked).toBe(false);

    await click(byText(container, "1900 MHz"));
    expect(await applyPicked(ref)).toBe(true);
    expect(setApi).toHaveBeenLastCalledWith(1900, false);
  });

  it("keeps the pick and reports an error when only some units take the cap", async () => {
    statusApi.mockResolvedValue(ready(2100, "cron"));
    setApi.mockResolvedValue(done([
      { id: "spark1", ok: true, capMHz: 1800, persistKind: "cron" },
      { id: "spark2", ok: false, error: "nvidia-smi -lgc failed" },
    ]));
    const ref = { current: null as FleetGpuClockApi | null };
    const { container } = render(<FleetGpuClock apiRef={ref} />);
    await settle();

    await click(byText(container, "1800 MHz"));
    expect(await applyPicked(ref)).toBe(false);

    const msg = status(container)!;
    expect(msg.textContent).toContain("Capped at 1800 MHz — 1 of 2 units — kept by an @reboot cron job on each unit");
    expect(msg.textContent).toContain("spark2: nvidia-smi -lgc failed");
    expect(msg.textContent).not.toContain("spark1:");
    // Not the boot-hook refusal, so no advice to untick the box.
    expect(msg.textContent).not.toContain("Untick");
    expect(msg.className).toContain("is-err");
    // spark2 never took it: the pick stays for Save to retry.
    expect(ref.current!.pending()).toBe(true);
    expect(byText(container, "1800 MHz").className).toContain("is-picked");
  });

  it("ignores a slow read from before the apply that answers after the read that follows it", async () => {
    const slow = deferred<GpuClockStatus>();
    const asked = new Set<string>();
    // Each unit's first read (from opening the row) stalls; later reads answer at once.
    statusApi.mockImplementation(async (id) => {
      if (asked.has(id)) return ready(1800);
      asked.add(id);
      return slow.promise;
    });
    setApi.mockResolvedValue(done([
      { id: "spark1", ok: true, capMHz: 1800, persistKind: "unit" },
      { id: "spark2", ok: true, capMHz: 1800, persistKind: "unit" },
    ]));
    const ref = { current: null as FleetGpuClockApi | null };
    const { container } = render(<FleetGpuClock apiRef={ref} />);
    await settle();
    const now = container.querySelector('[data-testid="fleet-now"]')!;
    expect(now.textContent).toContain("Reading the fleet");

    await click(byText(container, "1800 MHz"));
    expect(await applyPicked(ref)).toBe(true);
    expect(now.textContent).toContain("Now: capped at 1800 MHz on 2 units");

    await act(async () => slow.resolve(ready(2400)));
    await settle();

    expect(now.textContent).toContain("Now: capped at 1800 MHz on 2 units");
    expect(byText(container, "1800 MHz").className).toContain("is-current");
    expect(byText(container, "2400 MHz").className).not.toContain("is-current");
  });
});
