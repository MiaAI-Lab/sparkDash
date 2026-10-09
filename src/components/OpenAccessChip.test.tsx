import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { OPEN_ACCESS_DISMISSED_KEY, OpenAccessChip } from "./OpenAccessChip";
import { render } from "../testing/render";

function chip(container: HTMLElement) {
  return container.querySelector<HTMLButtonElement>(".open-access-chip");
}

describe("OpenAccessChip", () => {
  afterEach(() => localStorage.removeItem(OPEN_ACCESS_DISMISSED_KEY));

  it("warns on an open remote bind and explains it", () => {
    const { container } = render(<OpenAccessChip authMode="open-remote" />);
    const button = chip(container);
    expect(button?.textContent).toContain("Open access");
    expect(button?.title).toContain("SPARKDASH_TOKEN");
    act(() => button!.click());
    expect(container.querySelector('[role="dialog"]')?.textContent).toContain(
      "reachable from your network without a token"
    );
  });

  it.each(["loopback-open", "bearer", "required-missing", null] as const)(
    "stays hidden when authMode is %s",
    (mode) => {
      const { container } = render(<OpenAccessChip authMode={mode} />);
      expect(chip(container)).toBeNull();
    }
  );

  it("hides after dismiss and stays hidden for this browser", () => {
    const first = render(<OpenAccessChip authMode="open-remote" />).container;
    act(() => chip(first)!.click());
    const dismiss = first.querySelector<HTMLButtonElement>(".open-access-dismiss");
    act(() => dismiss!.click());
    expect(chip(first)).toBeNull();
    expect(localStorage.getItem(OPEN_ACCESS_DISMISSED_KEY)).toBe("1");

    const again = render(<OpenAccessChip authMode="open-remote" />).container;
    expect(chip(again)).toBeNull();
  });
});
