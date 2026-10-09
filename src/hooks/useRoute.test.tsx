import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useRoute, type RouteActions } from "./useRoute";
import { render } from "../testing/render";

describe("useRoute", () => {
  afterEach(() => {
    window.history.replaceState(null, "", "/");
  });

  function setup() {
    window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
    const setActive = vi.fn();
    let actions!: RouteActions;
    function Probe() {
      actions = useRoute(setActive);
      return null;
    }
    render(<Probe />);
    return { setActive, actions: () => actions };
  }

  it("navigate pushes a history entry and sets the id", () => {
    const { setActive, actions } = setup();
    const before = window.history.length;
    act(() => actions().navigate("alpha"));
    expect(window.location.pathname).toBe("/spark/alpha");
    expect(window.history.length).toBe(before + 1);
    expect(setActive).toHaveBeenCalledWith("alpha");
  });

  it("replace rewrites the URL in place", () => {
    const { setActive, actions } = setup();
    act(() => actions().navigate("alpha"));
    const len = window.history.length;
    act(() => actions().replace(null));
    expect(window.location.pathname).toBe("/");
    expect(window.history.length).toBe(len);
    expect(setActive).toHaveBeenLastCalledWith(null);
  });

  it("popstate sets the id from the URL", () => {
    const { setActive } = setup();
    window.history.replaceState(null, "", "/energy");
    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(setActive).toHaveBeenCalledWith("__energy__");
  });
});
