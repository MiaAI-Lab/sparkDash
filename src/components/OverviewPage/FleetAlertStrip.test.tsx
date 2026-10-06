import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FleetAlertStrip } from "./FleetAlertStrip";
import type { AlertInstance } from "../../api/types";
import { makeSpark } from "../../testing/fixtures";
import { render } from "../../testing/render";

const NOW = 1_800_000_000_000;

function serverAlert(over: Partial<AlertInstance> = {}): AlertInstance {
  return {
    key: "memory_headroom:spark-1",
    ruleId: "memory_headroom",
    ruleName: "Memory headroom",
    unitId: "spark-1",
    unitName: "Spark spark-1",
    severity: "warning",
    state: "firing",
    summary: "7.2 GB unified memory free (low < 8.0 GB)",
    value: 7373,
    startsAt: NOW - 125 * 60_000,
    firingAt: NOW - 123 * 60_000,
    ...over,
  };
}

function chips() {
  return Array.from(document.querySelectorAll("#fleet-alerts-title ~ ul button")).map((b) => b.textContent);
}

describe("FleetAlertStrip", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  it("derives alerts in the browser while server alerts are off (unchanged behaviour)", () => {
    render(<FleetAlertStrip sparks={[makeSpark("a", false), makeSpark("b")]} serverAlerts={[serverAlert()]} />);
    expect(chips()).toEqual(["Spark a · Host unreachable · 0m"]);
  });

  it("shows the server's firing alerts with their real start time when alerts are on", () => {
    const onSelect = vi.fn();
    render(
      <FleetAlertStrip
        sparks={[makeSpark("a", false)]}
        alertsEnabled
        serverAlerts={[serverAlert(), serverAlert({ key: "unit_offline:x", unitId: "x", unitName: "X", ruleName: "Unit offline", summary: "Unreachable", severity: "critical", startsAt: NOW - 61_000 })]}
        onSelect={onSelect}
      />
    );
    // 125 minutes ago, not "0m": the duration survives a page reload.
    expect(chips()).toEqual([
      "Spark spark-1 · Memory headroom: 7.2 GB unified memory free (low < 8.0 GB) · 125m",
      "X · Unit offline: Unreachable · 1m",
    ]);
    const buttons = document.querySelectorAll<HTMLButtonElement>("#fleet-alerts-title ~ ul button");
    expect(buttons[1].className).toContain("text-danger");
    buttons[0].click();
    expect(onSelect).toHaveBeenCalledWith("spark-1");
  });

  it("alerts on with nothing firing reads as clear, even if the browser would derive one", () => {
    render(<FleetAlertStrip sparks={[makeSpark("a", false)]} alertsEnabled serverAlerts={[]} />);
    expect(document.body.textContent).toContain("No active fleet exceptions.");
  });
});
