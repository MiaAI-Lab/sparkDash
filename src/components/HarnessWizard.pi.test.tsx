import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { flush, render } from "../testing/render";
import { HarnessWizard } from "./HarnessWizard";
import { checkOccupancyHelper, deleteOccupancyHelper, fetchOccupancyHelpers, saveOccupancyHelpers } from "../api/client";

vi.mock("../api/client", () => ({
  fetchOccupancyHelpers: vi.fn(),
  saveOccupancyHelpers: vi.fn(),
  deleteOccupancyHelper: vi.fn(),
  checkOccupancyHelper: vi.fn(),
}));

const sparks = [{ id: "dgx-spark", name: "DGX Spark", llmPorts: [8000] }];

function button(text: string) {
  return [...document.querySelectorAll("button")].find((item) => item.textContent === text);
}
function setValue(label: string, value: string) {
  const input = document.querySelector(`[aria-label="${label}"]`) as HTMLInputElement;
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
function saved() {
  return vi.mocked(saveOccupancyHelpers).mock.calls.at(-1)?.[0] ?? [];
}

describe("HarnessWizard Pi", () => {
  beforeEach(() => {
    vi.mocked(fetchOccupancyHelpers).mockResolvedValue({ helpers: [] });
    vi.mocked(saveOccupancyHelpers).mockImplementation(async (helpers) => ({
      helpers: helpers.map((helper, index) => ({
        id: helper.id || `helper-${index + 1}`,
        label: helper.label || "",
        url: helper.url,
        enabled: helper.enabled !== false,
        harnesses: helper.harnesses,
        routes: helper.routes,
        hasToken: Boolean(helper.token),
      })),
    }));
    vi.mocked(checkOccupancyHelper).mockResolvedValue({ ok: true, observedAt: 1, rowCount: 0, adapters: {} });
    vi.mocked(deleteOccupancyHelper).mockResolvedValue({ helpers: [] });
  });

  it("offers Pi separately from oh-my-pi and never creates a folder route for it", async () => {
    render(<HarnessWizard open sparks={sparks} sparkId="dgx-spark" onClose={vi.fn()} />);
    await flush();
    expect(document.querySelector('[aria-label="Pi"]')).toBeTruthy();
    expect(document.querySelector('[aria-label="oh-my-pi"]')).toBeTruthy();
    act(() => (document.querySelector('[aria-label="Pi"]') as HTMLInputElement).click());
    act(() => button("Next")!.click());
    setValue("Helper URL", "http://127.0.0.1:8792/occupancy");
    act(() => button("Next")!.click());
    // Step 3 explains the placement rule and shows no Pi route row.
    expect(document.querySelector('[aria-label="Spark for pi"]')).toBeNull();
    expect(document.body.textContent).toContain("no folder route");
    act(() => button("Next")!.click());
    act(() => button("Next")!.click());
    await act(async () => { button("Save")!.click(); await flush(); });
    const [helper] = saved();
    expect(helper.harnesses).toEqual(["pi"]);
    expect(helper.routes).toEqual([]);
  });
});
