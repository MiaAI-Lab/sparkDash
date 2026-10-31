import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TempsPage } from "./TempsPage";
import { flush, render } from "../../testing/render";
import { makeSpark } from "../../testing/fixtures";
import type { GpuHistoryResponse } from "../../api/client";
import { i18n } from "../../i18n";

vi.mock("../../api/client", () => ({
  getGpuHistory: vi.fn(() => Promise.resolve({ t: [], u: [], c: [], p: [] })),
}));

import { getGpuHistory } from "../../api/client";
const mockedGet = vi.mocked(getGpuHistory);

const DAY_MS = 24 * 3600_000;

function resp(temps: number[], stepMs = 60_000): GpuHistoryResponse {
  const now = 1_000_000_000_000;
  return {
    t: temps.map((_, i) => now - (temps.length - i) * stepMs),
    u: temps.map(() => 10),
    c: temps,
    p: temps.map(() => null),
  };
}

const buttons = (c: HTMLElement) => Array.from(c.querySelectorAll<HTMLButtonElement>(".seg button"));
const button = (c: HTMLElement, label: string) => buttons(c).find((b) => b.textContent === label)!;

describe("TempsPage", () => {
  beforeEach(() => {
    void i18n.changeLanguage("en");
    localStorage.clear();
    vi.clearAllMocks();
    mockedGet.mockReset().mockResolvedValue({ t: [], u: [], c: [], p: [] });
  });

  it("fetches the day window per spark and offers a week range that refetches", async () => {
    mockedGet.mockResolvedValue(resp([60, 61, 62], 600_000));
    const { container } = render(<TempsPage sparks={[makeSpark("a"), makeSpark("b")]} />);
    await flush();
    expect(mockedGet).toHaveBeenCalledTimes(2);
    for (const call of mockedGet.mock.calls) {
      expect(call[1]).toBe(DAY_MS);
    }
    act(() => button(container, "Last 7 d").click());
    await flush();
    expect(mockedGet).toHaveBeenCalledWith(expect.anything(), 7 * DAY_MS);
    expect(container.querySelector(".tp-grid")).not.toBeNull();
  });

  it("draws one line per card on a multi-GPU host and labels the legend", async () => {
    mockedGet.mockResolvedValue({
      ...resp([60, 61], 600_000),
      gpus: [
        { index: 0, name: "Card A", u: [1, 2], c: [60, 61], p: [null, null] },
        { index: 1, name: null, u: [3, 4], c: [62, 63], p: [null, null] },
      ],
    });
    const { container } = render(<TempsPage sparks={[makeSpark("a")]} />);
    await flush();
    const strokes = Array.from(container.querySelectorAll("svg path[stroke]")).map((p) => p.getAttribute("stroke"));
    expect(strokes[0]).not.toBe(strokes[1]);
    expect([...container.querySelectorAll(".legend span")].map((s) => s.textContent)).toEqual(["Card A", "GPU 1"]);
  });

  it("clips the lines to the plot area so a bucket that starts before the left edge stays off the axis labels", async () => {
    mockedGet.mockResolvedValue(resp([60, 61, 62], 600_000));
    const { container } = render(<TempsPage sparks={[makeSpark("a")]} />);
    await flush();
    const svg = container.querySelector("svg.tp-plot")!;
    const clip = svg.querySelector("clipPath");
    expect(clip?.id).toBeTruthy();
    const group = svg.querySelector(`g[clip-path="url(#${clip!.id})"]`);
    expect(group?.querySelector("path[stroke]")).not.toBeNull();
  });

  it("shows the warming-up state when no spark has samples in range", async () => {
    const { container } = render(<TempsPage sparks={[makeSpark("a")]} />);
    await flush();
    expect(container.textContent).toContain("Warming up");
  });

  it("keeps the selected range while labels update after a locale change", async () => {
    mockedGet.mockResolvedValue(resp([60, 61]));
    const { container } = render(<TempsPage sparks={[makeSpark("a")]} />);
    await flush();
    act(() => button(container, "Last 7 d").click());
    await flush();
    await act(async () => { await i18n.changeLanguage("zh-CN"); });
    expect(container.textContent).toContain("最近 7 天");
    expect(mockedGet).toHaveBeenCalledWith(expect.anything(), 7 * DAY_MS);
  });
});
