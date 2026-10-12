import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FleetAlertStrip, deriveAlerts, stripAlerts } from "./FleetAlertStrip";
import type { AlertInstance, SparkSnapshot } from "../../api/types";
import { makeSpark } from "../../testing/fixtures";
import { render } from "../../testing/render";

const NOW = 1_800_000_000_000;

function throttled(id: string, reason: "thermal" | "power"): SparkSnapshot {
  const s = makeSpark(id);
  s.metrics.gpu = {
    ...s.metrics.gpu!,
    temperature: 88,
    throttle: { active: true, reason, thermal: reason === "thermal", hwSlowdown: false, powerCap: reason === "power", detail: reason === "thermal" ? "HW thermal slowdown" : "SW power cap", smClockMHz: 1200, smClockPct: 40 },
  } as SparkSnapshot["metrics"]["gpu"];
  return s;
}

function serverAlert(over: Partial<AlertInstance> = {}): AlertInstance {
  return {
    key: "spark-1:memory",
    ruleId: "memory",
    ruleName: "Unified memory low",
    unitId: "spark-1",
    unitName: "Spark spark-1",
    severity: "warning",
    state: "firing",
    label: "Unified memory is running low",
    summary: "2.8 GB available of 122 GB.",
    startsAt: NOW - 125 * 60_000,
    firingAt: NOW - 124 * 60_000,
    ...over,
  };
}

const rows = () => [...document.querySelectorAll(".ov-alert")].map((el) => el.querySelector(".ov-alert__text")?.textContent);

describe("deriveAlerts (shared with the server's notifications)", () => {
  it("keeps the strip's rules: offline, thermal throttle; a software power cap is not an alert", () => {
    const keys = deriveAlerts([makeSpark("a", false), throttled("b", "thermal"), throttled("c", "power")]).map((a) => `${a.key}:${a.severity}`);
    expect(keys).toEqual(["a:offline:critical", "b:throttle:critical"]);
  });

  it("honours the temperature unit", () => {
    const [a] = deriveAlerts([throttled("b", "thermal")], "fahrenheit");
    expect(a.detail).toBe("HW thermal slowdown · GPU at 190°F · SM clock 1.2 GHz (40% of max)");
  });
});

describe("FleetAlertStrip", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  it("derives its own alerts while notifications are off (unchanged behaviour)", () => {
    render(<FleetAlertStrip sparks={[makeSpark("a", false), makeSpark("b")]} serverAlerts={[serverAlert()]} />);
    expect(rows()).toEqual(["Spark a Host unreachable.0m active"]);
  });

  it("lists the server's firing alerts with their real start time when notifications are on", () => {
    const onSelect = vi.fn();
    render(
      <FleetAlertStrip
        sparks={[makeSpark("spark-1")]}
        alertsEnabled
        serverAlerts={[serverAlert(), serverAlert({ key: "x:offline", ruleId: "offline", unitId: "x", unitName: "X", label: "Host unreachable", summary: "Unreachable: timeout", severity: "critical", startsAt: NOW - 61_000 })]}
        onSelect={onSelect}
      />
    );
    // 125 minutes, not "0m": the duration survives a page reload.
    expect(rows()).toEqual([
      "Spark spark-1 Unified memory is running low.2.8 GB available of 122 GB. · 125m active",
      "X Host unreachable.Unreachable: timeout · 1m active",
    ]);
    expect(document.querySelectorAll(".ov-alert")[1].className).toContain("ov-alert--bad");
    document.querySelector<HTMLButtonElement>(".ov-alert button")!.click();
    expect(onSelect).toHaveBeenCalledWith("spark-1");
  });

  it("a server strip alert takes its text from the live snapshot, so °F applies", () => {
    const [row] = stripAlerts({
      sparks: [throttled("b", "thermal")],
      alertsEnabled: true,
      serverAlerts: [serverAlert({ key: "b:throttle", ruleId: "throttle", unitId: "b", label: "is thermal throttling", summary: "HW thermal slowdown · GPU at 88°C", severity: "critical" })],
      temperatureUnit: "fahrenheit",
    });
    expect(row.detail).toContain("GPU at 190°F");
    expect(row.startsAt).toBe(NOW - 125 * 60_000);
  });

  it("showExceptions off keeps only throttle alerts, in both modes", () => {
    const sparks = [makeSpark("a", false), throttled("b", "thermal")];
    expect(stripAlerts({ sparks, showExceptions: false }).map((a) => a.key)).toEqual(["b:throttle"]);
    const server = [serverAlert(), serverAlert({ key: "b:throttle", ruleId: "throttle", unitId: "b", severity: "critical" })];
    expect(stripAlerts({ sparks, alertsEnabled: true, serverAlerts: server, showExceptions: false }).map((a) => a.key)).toEqual(["b:throttle"]);
  });

  it("notifications on but no server set yet: falls back to its own derivation", () => {
    expect(stripAlerts({ sparks: [makeSpark("a", false)], alertsEnabled: true, serverAlerts: null }).map((a) => a.key)).toEqual(["a:offline"]);
  });

  it("notifications on with nothing firing shows nothing, even where the browser would derive one", () => {
    render(<FleetAlertStrip sparks={[makeSpark("a", false)]} alertsEnabled serverAlerts={[]} />);
    expect(rows()).toEqual([]);
  });
});
