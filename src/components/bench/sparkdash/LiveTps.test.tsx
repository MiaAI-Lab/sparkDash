import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "../../../testing/render";
import { LiveTps } from "./LiveTps";

const live = () => document.querySelector('[aria-label="Live generation speed"]') as HTMLElement | null;

describe("LiveTps", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("shows the current reading and the peak seen while running", () => {
    const { root } = render(<LiveTps tps={40} active />);
    expect(live()?.textContent).toContain("40.0");
    act(() => void vi.advanceTimersByTime(1000));
    act(() => root.render(<LiveTps tps={72.5} active />));
    act(() => void vi.advanceTimersByTime(1000));
    act(() => root.render(<LiveTps tps={55} active />));
    expect(live()?.textContent).toContain("55.0");
    expect(live()?.textContent).toContain("peak 72.5 tok/s");
  });

  it("renders nothing without a reading (Remote target) or when not running", () => {
    const { root, container } = render(<LiveTps tps={null} active />);
    expect(container.innerHTML).toBe("");
    act(() => root.render(<LiveTps tps={50} active={false} />));
    expect(container.innerHTML).toBe("");
  });
});
