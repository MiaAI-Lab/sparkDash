import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DelegationDeskPanel } from "./DelegationDeskPanel";
import { OverviewPage } from "./OverviewPage";
import { flush, render } from "../../testing/render";
import { makeSpark } from "../../testing/fixtures";
import type { DelegationDeskStatus, DeskOverride, DeskRoute } from "../../api/types";

vi.mock(import("../../api/client"), async (importOriginal) => ({
  ...(await importOriginal()),
  fetchDelegationDesk: vi.fn(),
  setDeskOverride: vi.fn(),
  removeDeskOverride: vi.fn(),
  makeDeskOverridePermanent: vi.fn(),
}));

import { ApiError, fetchDelegationDesk, makeDeskOverridePermanent, removeDeskOverride, setDeskOverride } from "../../api/client";

const fetchDesk = vi.mocked(fetchDelegationDesk);
const putOverride = vi.mocked(setDeskOverride);
const deleteOverride = vi.mocked(removeDeskOverride);
const openPr = vi.mocked(makeDeskOverridePermanent);

const NOW = () => Math.floor(Date.now() / 1000);
const UNITS = { qualitycorp: "QualityCorp", john: "John", mama: "mama" };
const LOCAL_NAMES: Record<string, string> = {
  qualitycorp: "DeepSeek V4.1, QualityCorp",
  john: "DeepSeek V4.1, John",
  mama: "Qwen 3.8 27B, mama",
};

function local(key: string, unit: string, extra: Partial<DeskRoute> = {}, signal: Partial<NonNullable<DeskRoute["signal"]>> = {}): DeskRoute {
  return {
    key, name: LOCAL_NAMES[unit], provider: "Pi", model: `${unit}-oq/DeepSeek-V4.1-Flash`, budget: 2, roster_budget: 2, load: 0, live: [],
    signal: { kind: "saturation", unit, age: 8.7, state: "room", detail: "waiting 0, KV cache 0.355732", running: 1, waiting: 0, kv_cache: 0.355732, ...signal },
    signals: null,
    ...extra,
  };
}

function quotaSignal(remaining: number, state = "room") {
  return {
    kind: "quota" as const, source: "agy", age: 136, state, detail: "",
    windows: [{ name: "weekly", remaining, resets_at: NOW() + 3 * 86_400 }, { name: "5h", remaining: 71, resets_at: NOW() + 3_600 }],
  };
}

function snapshot(overrides: Partial<DelegationDeskStatus> = {}): DelegationDeskStatus {
  return {
    version: "v1",
    canEdit: true,
    routes: [
      local("deepseek-qualitycorp", "qualitycorp", {
        load: 2,
        live: [
          { id: "a", title: "[c4 mechanical-ui] QC: finish walkthrough fixes", host: "MK-MacBook-Pro-5", source: "t3:~/.t3" },
          { id: "b", title: "[c5 test] QC: skill wrapper tests", host: "MK-MacBook-Pro-5", source: "t3:~/.t3" },
        ],
      }, { detail: "waiting 0, KV cache n/a", running: 0, kv_cache: null }),
      local("deepseek-john", "john", { budget: 6, roster_budget: 6, load: 3 }),
      local("qwen-mama", "mama", { budget: 1, roster_budget: 1, load: 1 }, { detail: "waiting 0, KV cache n/a", running: 0, kv_cache: null }),
      {
        key: "gemini-flash", name: "Gemini 3.8 Flash", provider: "Antigravity", model: "gemini-3.8-flash", budget: null, roster_budget: null, load: 0, live: [],
        signal: null,
        signals: { "MK-MacBook-Pro-5": quotaSignal(15), zeppola: quotaSignal(15), theshop: quotaSignal(15) },
      },
      {
        key: "sol", name: "GPT-6.1 Sol", provider: "Codex", model: "gpt-6.1-sol", budget: 4, roster_budget: 4, load: 3, live: [],
        signal: null,
        signals: { zeppola: { kind: "quota", source: "codex", age: 143, state: "room", windows: [{ name: "weekly", remaining: 87, resets_at: NOW() + 5 * 86_400 }] } },
      },
      {
        key: "opus", name: "Opus 5.5", provider: "Claude", model: "claude-opus-5-5", budget: null, roster_budget: null, load: 0, live: [],
        signal: {
          kind: "quota", source: "hub", age: 28.7, state: "room", detail: "2 of 2 hub accounts have room",
          accounts: [
            { account: "account 1", usable: true, reason: null, windows: [{ name: "5h", remaining: 38, resets_at: NOW() + 1_800 }, { name: "weekly", remaining: 53, resets_at: NOW() + 4 * 86_400 }] },
            { account: "account 2", usable: true, reason: null, windows: [{ name: "5h", remaining: 88, resets_at: NOW() + 7_200 }, { name: "weekly", remaining: 25, resets_at: NOW() + 3 * 86_400 }] },
          ],
        },
        signals: null,
      },
    ],
    hosts: {
      "MK-MacBook-Pro-5": { age: 10, state: "fresh" },
      zeppola: { age: 27, state: "fresh" },
      theshop: { age: 7, state: "fresh" },
    },
    claims: [],
    waiting: [],
    overrides: {},
    ...overrides,
  };
}

function override(extra: Partial<DeskOverride> = {}): DeskOverride {
  return { budget: 3, roster: 2, expires_at: NOW() + 4 * 3_600 - 30, pr: null, set_at: NOW(), ...extra };
}

function column(container: HTMLElement, name: string): HTMLElement {
  const col = [...container.querySelectorAll<HTMLElement>(".dd-col")].find((el) => el.querySelector(".dd-name b")?.textContent === name);
  if (!col) throw new Error(`no column ${name}`);
  return col;
}

function button(root: ParentNode, label: string | RegExp): HTMLButtonElement {
  const match = [...root.querySelectorAll<HTMLButtonElement>("button")].find((b) => {
    const text = b.getAttribute("aria-label") ?? b.textContent ?? "";
    return typeof label === "string" ? text === label : label.test(text);
  });
  if (!match) throw new Error(`no button ${label}`);
  return match;
}

function click(el: HTMLElement) {
  act(() => {
    el.focus();
    el.click();
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function renderPanel(data: DelegationDeskStatus = snapshot()) {
  fetchDesk.mockResolvedValue(data);
  const view = render(<DelegationDeskPanel unitNames={UNITS} />);
  await flush();
  return view;
}

async function editMode(container: HTMLElement) {
  click(button(container, "Adjust budgets"));
  await flush();
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("DelegationDeskPanel reading", () => {
  it("shows each local route's delegates and budget, requests, KV cache, age and verdict", async () => {
    const { container } = await renderPanel();
    const qc = column(container, "QualityCorp");
    expect(qc.textContent).toContain("DeepSeek V4.1");
    expect(qc.textContent).toContain("Delegates2 / 2");
    expect(qc.querySelectorAll(".dd-slots i.is-held")).toHaveLength(2);
    expect(qc.textContent).toContain("0 running");
    expect(qc.textContent).toContain("KV cachenot reported");
    expect(qc.textContent).toContain("Budget full · runtime idle");
    expect(qc.textContent).toContain("sparkDash · 9 s ago");
    const john = column(container, "John");
    expect(john.textContent).toContain("1 running");
    expect(john.textContent).toContain("36%");
    expect(john.textContent).toContain("3 delegate slots free");
    expect(container.querySelector(".dd-sec__meta")?.textContent).toBe("3 free slots");
  });

  it("names local columns by machine and model parts and cloud columns by their route name", async () => {
    const { container } = await renderPanel();
    expect(column(container, "QualityCorp").querySelector(".dd-model")?.textContent).toBe("DeepSeek V4.1");
    expect(column(container, "John").querySelector(".dd-model")?.textContent).toBe("DeepSeek V4.1");
    expect(column(container, "mama").querySelector(".dd-model")?.textContent).toBe("Qwen 3.8 27B");
    expect(column(container, "Gemini 3.8 Flash").querySelector(".dd-model")?.textContent).toBe("Antigravity");
    expect(column(container, "GPT-6.1 Sol").querySelector(".dd-model")?.textContent).toBe("Codex");
    expect(column(container, "Opus 5.5").querySelector(".dd-model")?.textContent).toBe("Claude");
  });

  it("reads waiting and KV cache from the structured gauges, not the detail text", async () => {
    const data = snapshot();
    data.routes[1] = local("deepseek-john", "john", { budget: 6, load: 3 }, { detail: "waiting 4, KV cache 0.7", running: 5, waiting: 2, kv_cache: 0.42 });
    const { container } = await renderPanel(data);
    const john = column(container, "John");
    expect(john.textContent).toContain("5 running · 2 waiting");
    expect(john.textContent).toContain("42%");
    expect(john.textContent).not.toContain("70%");
  });

  it("keeps a null structured gauge as not reported and does not parse the detail", async () => {
    const data = snapshot();
    data.routes[1] = local("deepseek-john", "john", { budget: 6, load: 3 }, { detail: "waiting 4, KV cache 0.7", running: 5, waiting: null, kv_cache: null });
    const { container } = await renderPanel(data);
    const john = column(container, "John");
    expect(john.textContent).toContain("5 running");
    expect(john.textContent).not.toContain("4 waiting");
    expect(john.textContent).not.toContain("70%");
    expect(john.textContent).toContain("KV cache");
    expect(john.textContent).toContain("not reported");
  });

  it("an older desk keeps the unit and model titles and its detail readings", async () => {
    const data = snapshot();
    for (const route of data.routes) {
      delete route.name;
      if (route.signal) {
        delete route.signal.waiting;
        delete route.signal.kv_cache;
      }
    }
    const { container } = await renderPanel(data);
    expect(column(container, "QualityCorp").querySelector(".dd-model")?.textContent).toBe("DeepSeek-V4.1-Flash");
    expect(column(container, "John").querySelector(".dd-model")?.textContent).toBe("DeepSeek-V4.1-Flash");
    expect(column(container, "gemini-3.8-flash")).toBeTruthy();
    expect(column(container, "claude-opus-5-5")).toBeTruthy();
    expect(column(container, "John").textContent).toContain("36%");
  });

  it("renders an unreported counter as not reported, never 0", async () => {
    const data = snapshot();
    data.routes[1] = local("deepseek-john", "john", { budget: 6, load: 1 }, { running: null, detail: "no waiting or KV-cache gauge", state: "no-signal" });
    const { container } = await renderPanel(data);
    const john = column(container, "John");
    expect(john.textContent).toContain("Requestsnot reported");
    expect(john.textContent).not.toContain("0 running");
    expect(john.textContent).toContain("No live data");
  });

  it("does not count a route with no live data as free capacity", async () => {
    const data = snapshot();
    data.routes[1] = local("deepseek-john", "john", { budget: 6, load: 1 }, { state: "no-signal", detail: "sparkDash reading is stale", running: null, age: 94 });
    const { container } = await renderPanel(data);
    expect(container.querySelector(".dd-sec__meta")?.textContent).toBe("No free slots · John unconfirmed");
    expect(column(container, "John").textContent).toContain("5 slots by budget · no live data to confirm");
  });

  it("says when hosts disagree on quota and shows the lowest reading", async () => {
    const data = snapshot();
    const gemini = data.routes[3];
    gemini.signals = { "MK-MacBook-Pro-5": quotaSignal(8, "full"), zeppola: quotaSignal(12), theshop: quotaSignal(8, "full") };
    const { container } = await renderPanel(data);
    const col = column(container, "Gemini 3.8 Flash");
    expect(col.textContent).toContain("Hosts disagree: MK-MacBook-Pro-5 8% · zeppola 12% · theshop 8%. Showing the lowest.");
    expect(col.textContent).toContain("Weekly8% left");
    expect(col.textContent).toContain("Quota low");
    expect(col.textContent).toContain("Under 10% left · treated as full");
  });

  it("shows each window's lowest reading when hosts disagree on different windows", async () => {
    const data = snapshot();
    const reading = (weekly: number, fiveHour: number) => ({
      ...quotaSignal(weekly),
      windows: [{ name: "weekly", remaining: weekly, resets_at: NOW() + 86_400 }, { name: "5h", remaining: fiveHour, resets_at: NOW() + 3_600 }],
    });
    data.routes[3].signals = { zeppola: reading(8, 90), theshop: reading(20, 12) };
    const { container } = await renderPanel(data);
    const col = column(container, "Gemini 3.8 Flash");
    expect(col.textContent).toContain("Weekly8% left");
    expect(col.textContent).toContain("5-hour12% left");
    expect(col.textContent).not.toContain("90% left");
    expect(col.textContent).toContain("lowest of 2 hosts");
  });

  it("keeps the last reading on screen, without budget controls, when a later poll fails", async () => {
    vi.useFakeTimers();
    try {
      const { container } = await renderPanel();
      expect(button(container, "Adjust budgets")).toBeTruthy();
      fetchDesk.mockRejectedValue(new Error("Can't reach the delegation desk: timed out after 3 s"));
      await act(async () => { vi.advanceTimersByTime(10_000); });
      await flush();
      expect(container.querySelector(".dd-cols")).not.toBeNull();
      expect(column(container, "QualityCorp").textContent).toContain("Delegates2 / 2");
      expect(container.querySelector(".ov-card__tools .tag--bad")?.textContent).toBe("Unreachable");
      expect(container.querySelector(".dd-note--bad")?.textContent).toContain("timed out after 3 s");
      expect(container.querySelector(".dd-note--bad")?.textContent).toContain("last good reading");
      expect(container.textContent).not.toContain("Adjust budgets");
    } finally {
      vi.useRealTimers();
    }
  });

  it("agreeing hosts show one reading; Opus shows its tightest account window with the rest disclosed", async () => {
    const { container } = await renderPanel();
    expect(column(container, "Gemini 3.8 Flash").textContent).toContain("3 hosts agree");
    const opus = column(container, "Opus 5.5");
    const visible = opus.querySelector(":scope > .dd-q");
    expect(visible?.textContent).toContain("account 2 weekly25% left");
    expect(opus.querySelector("details summary")?.textContent).toBe("All 2 accounts");
    expect(opus.querySelectorAll("details .dd-q")).toHaveLength(4);
    expect(opus.textContent).toContain("Delegates0 · quota only");
  });

  it("looks different when the desk is unreachable than when it is empty", async () => {
    fetchDesk.mockRejectedValue(new Error("Can't reach the delegation desk: timed out after 3 s"));
    const down = render(<DelegationDeskPanel />);
    await flush();
    expect(down.container.querySelector(".tag--bad")?.textContent).toBe("Unreachable");
    expect(down.container.textContent).toContain("timed out after 3 s");
    expect(down.container.textContent).toContain("Agents fail open");
    expect(down.container.querySelector(".dd-cols")).toBeNull();

    const empty = await renderPanel(snapshot({ routes: [] }));
    expect(empty.container.querySelector(".tag--bad")).toBeNull();
    expect(empty.container.textContent).toContain("The desk lists no routes.");
  });

  it("flags a stale host in the header and on its delegates", async () => {
    const data = snapshot();
    data.hosts["MK-MacBook-Pro-5"] = { age: 214, state: "stale" };
    const { container } = await renderPanel(data);
    expect(container.querySelector(".ov-card__tools .tag--warn")?.textContent).toBe("MK-MacBook-Pro-5 not reporting");
    const holder = column(container, "QualityCorp").querySelector("li");
    expect(holder?.className).toBe("is-stale");
    expect(holder?.textContent).toContain("host not reporting");
  });

  it("truncates a long title and keeps the full title reachable", async () => {
    const long = "shapey-history-redesign-empty-state-and-a-much-longer-title-than-usual-to-test-truncation";
    const data = snapshot({ waiting: [{ host: "zeppola", title: long }] });
    data.routes[1].live = [{ id: "fm", title: long, host: "zeppola", source: "firstmate:/x" }];
    const { container } = await renderPanel(data);
    const holder = column(container, "John").querySelector(".dd-list .dd-trunc");
    expect(holder?.getAttribute("title")).toBe(long);
    expect(holder?.className).toContain("dd-trunc");
    expect(column(container, "John").textContent).toContain("zeppola · Firstmate");
    expect(container.querySelector(".dd-waits summary")?.textContent).toBe("1 request waiting for a delegate slot");
    expect(container.querySelector(".dd-waits .dd-trunc")?.getAttribute("title")).toBe(long);
  });
});

describe("DelegationDeskPanel edit mode", () => {
  it("has no edit mode when the server holds no admin token", async () => {
    const { container } = await renderPanel(snapshot({ canEdit: false }));
    expect(container.textContent).not.toContain("Adjust budgets");
    expect(container.querySelector(".dd-stepper")).toBeNull();
  });

  it("is read-only until Adjust budgets, then explains the rules at each stepper", async () => {
    const { container } = await renderPanel();
    expect(container.querySelector(".dd-stepper")).toBeNull();
    await editMode(container);
    const qc = column(container, "QualityCorp");
    expect(qc.textContent).toContain("Roster 2. A change applies now for 4 h, up to 4. 0 pauses new delegations.");
    // Quota-only routes have no budget to change.
    expect(column(container, "Opus 5.5").querySelector(".dd-stepper")).toBeNull();
    expect(column(container, "GPT-6.1 Sol").querySelector(".dd-stepper")).not.toBeNull();
  });

  it("shows Saving… and the new value only after the desk acknowledges", async () => {
    const { container } = await renderPanel();
    await editMode(container);
    const ack = deferred<{ override: DeskOverride | null }>();
    putOverride.mockReturnValue(ack.promise);
    click(button(column(container, "QualityCorp"), "Raise QualityCorp budget to 3"));
    expect(putOverride).toHaveBeenCalledWith("deepseek-qualitycorp", 3);
    let qc = column(container, "QualityCorp");
    expect(qc.textContent).toContain("Saving QualityCorp at 3…");
    expect(qc.textContent).toContain("Delegates2 / 2");

    const after = snapshot({ overrides: { "deepseek-qualitycorp": override() } });
    after.routes[0].budget = 3;
    fetchDesk.mockResolvedValue(after);
    await act(async () => ack.resolve({ override: override() }));
    await flush();
    qc = column(container, "QualityCorp");
    expect(qc.textContent).not.toContain("Saving");
    expect(qc.textContent).toContain("2 / 3 · override");
    expect(qc.textContent).toContain("Override 2 → 3 · 3h 59m left");
    expect(container.querySelector(".tag--acc")?.textContent).toBe("1 override active");
  });

  it("ignores a status read that started before an acknowledged write", async () => {
    vi.useFakeTimers();
    try {
      const { container } = await renderPanel();
      await editMode(container);
      // The 10 s poll starts and is still waiting on the desk when the write is acknowledged.
      const slowPoll = deferred<DelegationDeskStatus>();
      fetchDesk.mockReturnValueOnce(slowPoll.promise);
      act(() => { vi.advanceTimersByTime(10_000); });
      putOverride.mockResolvedValue({ override: override() });
      const after = snapshot({ overrides: { "deepseek-qualitycorp": override() } });
      after.routes[0].budget = 3;
      fetchDesk.mockResolvedValue(after);
      click(button(column(container, "QualityCorp"), "Raise QualityCorp budget to 3"));
      await flush();
      await act(async () => slowPoll.resolve(snapshot()));
      await flush();
      expect(column(container, "QualityCorp").textContent).toContain("2 / 3 · override");
    } finally {
      vi.useRealTimers();
    }
  });

  it("allows one write per route at a time", async () => {
    const data = snapshot({ overrides: { "deepseek-qualitycorp": override() } });
    data.routes[0].budget = 3;
    const { container } = await renderPanel(data);
    await editMode(container);
    putOverride.mockReturnValue(deferred<{ override: DeskOverride | null }>().promise);
    click(button(column(container, "QualityCorp"), "Raise QualityCorp budget to 4"));
    const qc = column(container, "QualityCorp");
    expect(button(qc, "Remove override").getAttribute("aria-disabled")).toBe("true");
    click(button(qc, "Remove override"));
    click(button(qc, "Make permanent…"));
    click(button(qc, /^Lower QualityCorp/));
    await flush();
    expect(deleteOverride).not.toHaveBeenCalled();
    expect(putOverride).toHaveBeenCalledTimes(1);
    expect(column(container, "QualityCorp").textContent).not.toContain("in delegation.md?");
  });

  it("does not claim a write the desk may have applied left the budget unchanged", async () => {
    const { container } = await renderPanel();
    await editMode(container);
    putOverride.mockRejectedValue(new ApiError("The delegation desk did not answer (timed out after 5 s), so the change may or may not have applied", 504));
    const reads = fetchDesk.mock.calls.length;
    click(button(column(container, "QualityCorp"), "Raise QualityCorp budget to 3"));
    await flush();
    const alert = column(container, "QualityCorp").querySelector("[role=alert]")?.textContent ?? "";
    expect(alert).toContain("may or may not have applied. Showing the desk's current value.");
    expect(alert).not.toContain("stays at");
    expect(fetchDesk.mock.calls.length).toBe(reads + 1);
  });

  it("returns focus to the pressed button when the desk refuses a change at the limit", async () => {
    const data = snapshot();
    data.routes[2] = local("qwen-mama", "mama", { budget: 1, roster_budget: 1, load: 0 });
    const { container } = await renderPanel(data);
    await editMode(container);
    const ack = deferred<{ override: DeskOverride | null }>();
    putOverride.mockReturnValue(ack.promise);
    click(button(column(container, "mama"), "Raise mama budget to 2"));
    // A browser drops focus to the body when a focused button becomes disabled; jsdom keeps it,
    // so move focus to the body the way the browser would.
    act(() => {
      const elsewhere = document.createElement("input");
      document.body.append(elsewhere);
      elsewhere.focus();
      elsewhere.remove();
    });
    expect(document.activeElement).toBe(document.body);
    await act(async () => ack.reject(new Error("The delegation desk refused the change (HTTP 400)")));
    await flush();
    expect(document.activeElement).toBe(button(column(container, "mama"), /^Raise mama/));
  });

  it("shows a refused write's error and keeps the old value", async () => {
    const { container } = await renderPanel();
    await editMode(container);
    putOverride.mockRejectedValue(new Error("The delegation desk refused sparkDash's admin token"));
    click(button(column(container, "QualityCorp"), "Raise QualityCorp budget to 3"));
    await flush();
    const qc = column(container, "QualityCorp");
    expect(qc.querySelector("[role=alert]")?.textContent).toBe("The delegation desk refused sparkDash's admin token. QualityCorp stays at 2.");
    expect(qc.querySelector(".dd-stepper output")?.textContent).toBe("2");
    expect(qc.textContent).toContain("Delegates2 / 2");
  });

  it("locks the stepper while a PR is open, and can remove the override with the PR left open", async () => {
    const held = override({ expires_at: null, pr: { number: 731, url: "https://github.com/o/r/pull/731", state: "open" } });
    const data = snapshot({ overrides: { "deepseek-qualitycorp": held } });
    data.routes[0].budget = 3;
    const { container } = await renderPanel(data);
    await editMode(container);
    const qc = column(container, "QualityCorp");
    expect(button(qc, /^Lower QualityCorp/).disabled).toBe(true);
    expect(button(qc, /^Raise QualityCorp/).disabled).toBe(true);
    expect(qc.textContent).toContain("Locked while the PR is open.");
    expect(qc.textContent).toContain("Override 2 → 3 · held for PR #731");
    expect(qc.querySelector("a")?.getAttribute("href")).toBe("https://github.com/o/r/pull/731");

    deleteOverride.mockResolvedValue({ removed: true });
    fetchDesk.mockResolvedValue(snapshot());
    click(button(qc, "Remove override (PR stays open)"));
    await flush();
    expect(deleteOverride).toHaveBeenCalledWith("deepseek-qualitycorp");
    expect(column(container, "QualityCorp").textContent).toContain("Roster 2.");
  });

  it("confirms Make permanent inline, naming the file and the login, then holds the override for the PR", async () => {
    const data = snapshot({ overrides: { "deepseek-qualitycorp": override() } });
    data.routes[0].budget = 3;
    const { container } = await renderPanel(data);
    await editMode(container);
    click(button(column(container, "QualityCorp"), "Make permanent…"));
    const qc = column(container, "QualityCorp");
    expect(qc.textContent).toContain("Change QualityCorp from 2 to 3 in delegation.md?");
    expect(qc.textContent).toContain("using the desk's GitHub login");
    const held = override({ expires_at: null, pr: { number: 732, url: "https://github.com/o/r/pull/732", state: "open" } });
    openPr.mockResolvedValue({ override: held, pr: { number: 732, url: "https://github.com/o/r/pull/732" } });
    const after = snapshot({ overrides: { "deepseek-qualitycorp": held } });
    after.routes[0].budget = 3;
    fetchDesk.mockResolvedValue(after);
    click(button(qc, "Open PR"));
    await flush();
    expect(openPr).toHaveBeenCalledWith("deepseek-qualitycorp");
    expect(column(container, "QualityCorp").textContent).toContain("held for PR #732");
  });

  it("disables the stepper at 0 and at twice the roster, moving focus to the other button", async () => {
    const data = snapshot();
    data.routes[2] = local("qwen-mama", "mama", { budget: 1, roster_budget: 1, load: 0 });
    const { container } = await renderPanel(data);
    await editMode(container);

    const deskAt = (budget: number) => {
      const next = snapshot();
      next.routes[2] = local("qwen-mama", "mama", { budget, roster_budget: 1, load: 0 });
      if (budget !== 1) next.overrides = { "qwen-mama": override({ budget, roster: 1 }) };
      fetchDesk.mockResolvedValue(next);
      putOverride.mockResolvedValue({ override: budget === 1 ? null : override({ budget, roster: 1 }) });
    };
    deskAt(0);
    click(button(column(container, "mama"), "Lower mama budget to 0"));
    await flush();
    let mama = column(container, "mama");
    expect(button(mama, /^Lower mama/).disabled).toBe(true);
    expect(document.activeElement).toBe(button(mama, /^Raise mama/));
    expect(mama.textContent).toContain("Paused · running work continues, new work skips it");

    deskAt(1);
    click(button(mama, "Raise mama budget to 1"));
    await flush();
    deskAt(2);
    click(button(column(container, "mama"), "Raise mama budget to 2"));
    await flush();
    mama = column(container, "mama");
    expect(button(mama, /^Raise mama/).disabled).toBe(true);
    expect(document.activeElement).toBe(button(mama, /^Lower mama/));
  });
});

describe("Delegation desk toggle", () => {
  it("is absent and makes no request while off", async () => {
    fetchDesk.mockResolvedValue(snapshot());
    const { container } = render(<OverviewPage sparks={[makeSpark()]} showDelegationDesk={false} showFleetEnergy={false} showLlmTokenTotals={false} showActivityFeed={false} />);
    await flush();
    expect(container.querySelector(".ov-dd")).toBeNull();
    expect(fetchDesk).not.toHaveBeenCalled();
  });

  it("shows the panel and polls once switched on", async () => {
    fetchDesk.mockResolvedValue(snapshot());
    const { container } = render(<OverviewPage sparks={[makeSpark()]} showDelegationDesk showFleetEnergy={false} showLlmTokenTotals={false} showActivityFeed={false} />);
    await flush();
    expect(container.querySelector(".ov-dd")).not.toBeNull();
    expect(fetchDesk).toHaveBeenCalledTimes(1);
  });
});
