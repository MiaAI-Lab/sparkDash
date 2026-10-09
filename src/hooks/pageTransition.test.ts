import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withPageTransition } from "./pageTransition";

describe("withPageTransition", () => {
  let scrollTo: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    scrollTo = vi.fn();
    vi.stubGlobal("scrollTo", scrollTo);
    window.scrollTo = scrollTo as unknown as typeof window.scrollTo;
    window.matchMedia = ((q: string) => ({ matches: q.includes("reduce") && reduce })) as unknown as typeof window.matchMedia;
  });
  let reduce = false;
  afterEach(() => {
    reduce = false;
    delete (document as { startViewTransition?: unknown }).startViewTransition;
    vi.unstubAllGlobals();
  });

  it("scrolls to the top after a forward navigation, without View Transitions", () => {
    const order: string[] = [];
    scrollTo.mockImplementation(() => order.push("scroll"));
    withPageTransition(() => order.push("update"), { scrollTop: true });
    expect(order).toEqual(["update", "scroll"]);
  });

  it("leaves the scroll alone for popstate (no option)", () => {
    withPageTransition(() => {});
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("scrolls inside the transition callback when View Transitions run", () => {
    const order: string[] = [];
    scrollTo.mockImplementation(() => order.push("scroll"));
    (document as unknown as { startViewTransition: (cb: () => void) => void }).startViewTransition = (cb) => {
      order.push("start");
      cb();
    };
    withPageTransition(() => order.push("update"), { scrollTop: true });
    expect(order).toEqual(["start", "update", "scroll"]);
  });

  it("skips the transition under reduced motion but still updates and scrolls", () => {
    reduce = true;
    const start = vi.fn();
    (document as unknown as { startViewTransition: unknown }).startViewTransition = start;
    const update = vi.fn();
    withPageTransition(update, { scrollTop: true });
    expect(start).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalled();
    expect(scrollTo).toHaveBeenCalledWith(0, 0);
  });
});
