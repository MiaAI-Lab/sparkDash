import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { render } from "../../testing/render";
import { BenchPageShell } from "./BenchPageShell";

function shell(type: string) {
  return render(
    <BenchPageShell type={type} spark={null} sparks={[]} onSelectSpark={() => {}}>
      <p>body</p>
    </BenchPageShell>
  );
}

describe("BenchPageShell", () => {
  it("shows the compare sub-page as a sub-tab of Quality and navigates on click", () => {
    const onNav = vi.fn();
    window.addEventListener("sparkdash:navigate", onNav);
    try {
      const { container } = shell("quality");
      const tabs = [...container.querySelectorAll<HTMLButtonElement>(".bench-subtabs__tab")];
      expect(tabs.map((b) => b.textContent)).toEqual(["Suite", "Compare"]);
      expect(container.querySelector(".bench-subtabs__tab.is-active")?.textContent).toBe("Suite");
      act(() => tabs[1]!.click());
      expect(onNav).toHaveBeenCalledTimes(1);
      expect((onNav.mock.calls[0]![0] as CustomEvent).detail).toBe("__bench__:quality-compare");
    } finally {
      window.removeEventListener("sparkdash:navigate", onNav);
    }
  });

  it("keeps the Quality header on the compare sub-page with the Compare tab active and its own sub line", () => {
    const { container } = shell("quality-compare");
    expect(container.querySelector(".page-head h1")?.textContent).toBe("Quality");
    expect(container.querySelector(".page-head__sub")?.textContent).toContain("Any two saved quality runs");
    expect(container.querySelector(".bench-subtabs__tab.is-active")?.textContent).toBe("Compare");
  });

  it("renders no sub-tabs for benches without sub-pages", () => {
    const { container } = shell("decode");
    expect(container.querySelector(".bench-subtabs")).toBeNull();
    expect(container.querySelector(".page-head h1")?.textContent).toBe("Decode");
  });
});
