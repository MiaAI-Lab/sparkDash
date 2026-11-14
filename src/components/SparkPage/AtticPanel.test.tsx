import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { setLocale } from "../../i18n";
import { AtticPanel } from "./AtticPanel";
import { render } from "../../testing/render";
import type { AtticMetrics, AtticStatus, AtticUnit } from "../../api/types";

const unit = (present: boolean | null, active: boolean | null, state: string | null): AtticUnit => ({
  present,
  active,
  state,
});
const RUNNING = unit(true, true, "active");
const NOT_INSTALLED = unit(false, false, "not installed");
const UNKNOWN_UNIT = unit(null, null, null);

const READY: AtticStatus = {
  status: "ready",
  why: null,
  version: "0.1.0",
  driver: "580.178.04",
  mode: "heap",
  validated: true,
  validatedAt: "2026-11-02T23:25:31Z",
  sizeMib: 2044,
  freeMib: 0,
  largestMib: 0,
  lentMib: 2044,
  drainingMib: 0,
  clients: 2,
  ageS: 4,
  everyS: 10,
};

const NO_NUMBERS: Omit<AtticStatus, "status"> = {
  why: null,
  version: "0.1.0",
  driver: null,
  mode: null,
  validated: null,
  validatedAt: null,
  sizeMib: null,
  freeMib: null,
  largestMib: null,
  lentMib: null,
  drainingMib: null,
  clients: null,
  ageS: 95,
  everyS: 10,
};

function metrics(over: Partial<AtticMetrics> = {}): AtticMetrics {
  return {
    available: true,
    state: "lending",
    attic: READY,
    atticd: RUNNING,
    error: null,
    ...over,
  };
}

function read(container: HTMLElement) {
  const tags = Array.from(container.querySelectorAll<HTMLElement>(".tag")).map((el) => ({
    text: el.textContent,
    tone: el.className,
  }));
  const rows = Object.fromEntries(
    Array.from(container.querySelectorAll(".sp-list-row")).map((row) => [
      row.children[0]?.textContent ?? "",
      row.children[1]?.textContent ?? "",
    ]),
  );
  const callouts = Array.from(container.querySelectorAll(".sp-callout")).map((el) => ({
    text: el.textContent ?? "",
    bad: el.classList.contains("sp-callout--bad"),
  }));
  return { text: container.textContent ?? "", tags, rows, callouts };
}

function view(attic: AtticMetrics | null) {
  return read(render(<AtticPanel attic={attic} />).container);
}

afterEach(async () => {
  await act(() => setLocale("en"));
});

describe("AtticPanel", () => {
  it("waits for the first poll without claiming a state", () => {
    const v = view(null);
    expect(v.tags.map((t) => t.text)).toEqual(["unknown"]);
    expect(v.text).toContain("Waiting for first poll");
    expect(v.rows).toEqual({});
    expect(v.callouts).toEqual([]);
  });

  it("shows what spark-attic lends, from a fresh status file", () => {
    const v = view(metrics());
    expect(v.tags).toEqual([{ text: "lending", tone: expect.stringContaining("tag--good") }]);
    expect(v.rows).toEqual({
      Lent: "2,044 of 2,044 MiB",
      Free: "0 MiB",
      Clients: "2",
      Mode: "heap",
      Driver: "580.178.04, validated",
      Updated: "4 s ago",
      atticd: "0.1.0",
    });
    expect(v.callouts).toEqual([]);
  });

  it("shows nothing lent yet as lending 0, a slice still returning and the largest free block", () => {
    expect(view(metrics({ attic: { ...READY, lentMib: 0, freeMib: 2044, largestMib: 2044, clients: 0 } })).rows).toMatchObject({
      Lent: "0 of 2,044 MiB",
      Free: "2,044 MiB",
    });
    const v = view(metrics({ attic: { ...READY, lentMib: 1024, drainingMib: 64, freeMib: 956, largestMib: 512 } }));
    expect(v.rows.Lent).toBe("1,024 of 2,044 MiB (+64 MiB returning)");
    expect(v.rows.Free).toBe("956 MiB");
    expect(v.rows["Largest block"]).toBe("512 MiB");
  });

  it("says why atticd refuses", () => {
    const why = "bring-up check failed: the carveout is 0 MiB";
    const v = view(metrics({ state: "refusing", attic: { ...READY, status: "refusing", why, sizeMib: 0, lentMib: 0 } }));
    expect(v.tags).toEqual([{ text: "refusing", tone: expect.stringContaining("tag--warn") }]);
    expect(v.callouts).toEqual([{ text: why, bad: false }]);
    expect(v.rows.Lent).toBeUndefined();
    expect(v.rows.Driver).toBe("580.178.04, validated");
  });

  it("names the driver that waits for validation", () => {
    const v = view(
      metrics({
        state: "unvalidated",
        attic: {
          ...READY,
          status: "refusing",
          why: "driver 580.196.07 has no VALIDATED artifact for heap",
          driver: "580.196.07",
          validated: false,
          validatedAt: null,
          sizeMib: 0,
          lentMib: 0,
          clients: 0,
        },
      }),
    );
    expect(v.tags).toEqual([{ text: "driver not yet validated", tone: expect.stringContaining("tag--warn") }]);
    expect(v.callouts).toEqual([
      { text: "atticd lends nothing until driver 580.196.07 is validated for heap mode (attic-validate.sh).", bad: false },
    ]);
    expect(v.rows.Driver).toBe("580.196.07, not yet validated");
    expect(v.rows.Lent).toBeUndefined();
  });

  it("shows attic.service off: stopped or failed", () => {
    const off = view(metrics({ state: "off", attic: null, atticd: unit(true, false, "inactive") }));
    expect(off.tags.map((t) => t.text)).toEqual(["off"]);
    expect(off.rows).toEqual({ "attic.service": "stopped" });
    expect(off.callouts).toEqual([]);
    const failed = view(metrics({ state: "off", attic: { ...NO_NUMBERS, status: "stale", ageS: 900 }, atticd: unit(true, false, "failed") }));
    expect(failed.tags.map((t) => t.text)).toEqual(["off"]);
    expect(failed.rows["attic.service"]).toBe("failed");
    expect(failed.rows.Lent).toBeUndefined();
  });

  it("shows spark-attic not installed", () => {
    const v = view(metrics({ state: "not installed", attic: null, atticd: NOT_INSTALLED }));
    expect(v.tags.map((t) => t.text)).toEqual(["not installed"]);
    expect(v.rows).toEqual({ "attic.service": "not installed" });
  });

  it("keeps a stale status file unknown: no numbers", () => {
    const v = view(metrics({ state: "unknown", attic: { ...NO_NUMBERS, status: "stale" } }));
    expect(v.tags).toEqual([{ text: "unknown", tone: expect.stringContaining("tag--bad") }]);
    expect(v.callouts).toHaveLength(1);
    expect(v.callouts[0].bad).toBe(true);
    expect(v.callouts[0].text).toContain("95 s ago");
    expect(v.callouts[0].text).toContain("not running");
    expect(v.rows.Lent).toBeUndefined();
    expect(v.rows.Free).toBeUndefined();
    expect(v.rows["attic.service"]).toBe("running");
  });

  it("keeps an unreadable status file unknown", () => {
    const why = "cannot read /run/spark-attic/status.json";
    const v = view(metrics({ state: "unknown", attic: { ...NO_NUMBERS, status: "unreadable", why, version: null } }));
    expect(v.tags).toEqual([{ text: "unknown", tone: expect.stringContaining("tag--bad") }]);
    expect(v.callouts).toEqual([{ text: why, bad: true }]);
    expect(v.rows.Lent).toBeUndefined();
  });

  it("says why it cannot tell, with no status file", () => {
    expect(view(metrics({ state: "unknown", attic: null, atticd: UNKNOWN_UNIT })).callouts).toEqual([
      { text: "No status file, and systemd did not answer for attic.service.", bad: false },
    ]);
    const noFile = view(metrics({ state: "unknown", attic: null, atticd: RUNNING }));
    expect(noFile.callouts[0].text).toContain("writes no status file");
    expect(noFile.rows).toEqual({ "attic.service": "running" });
    expect(view(metrics({ state: "unknown", attic: null, atticd: unit(true, null, "activating") })).callouts).toEqual([
      { text: "attic.service is activating.", bad: false },
    ]);
  });

  it("shows a failed probe as unknown, with its error", () => {
    const v = view(
      metrics({
        available: false,
        state: "unknown",
        attic: null,
        atticd: UNKNOWN_UNIT,
        error: "SSH to 192.0.2.8:22 failed: No route to host",
      }),
    );
    expect(v.tags.map((t) => t.text)).toEqual(["unknown"]);
    expect(v.callouts).toEqual([{ text: "SSH to 192.0.2.8:22 failed: No route to host", bad: false }]);
    expect(v.rows).toEqual({});
    expect(v.text).not.toContain("Waiting for first poll");
  });

  it("switches to Simplified Chinese without changing the numbers", async () => {
    const { container } = render(<AtticPanel attic={metrics()} />);
    await act(() => setLocale("zh-CN"));
    const v = read(container);
    expect(v.tags.map((t) => t.text)).toEqual(["借出中"]);
    expect(v.rows["已借出"]).toBe("2,044 / 2,044 MiB");
    expect(v.rows["驱动"]).toBe("580.178.04，已验证");
    expect(container.querySelector(".panel-title")?.textContent).toContain("闲置 GPU 内存");
  });
});
