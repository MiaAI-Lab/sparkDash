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

const sparks = [{ id: "mama", name: "mama", llmPorts: [8000] }];

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

describe("HarnessWizard", () => {
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
    vi.mocked(checkOccupancyHelper).mockResolvedValue({
      ok: true,
      observedAt: 1,
      rowCount: 3,
      adapters: { opencode: { coverage: "supported", stale: false, rows: 3, error: null } },
    });
    vi.mocked(deleteOccupancyHelper).mockResolvedValue({ helpers: [] });
  });

  it("saves one helper, shows coverage without session titles, and prints one snippet", async () => {
    render(<HarnessWizard open sparks={sparks} sparkId="mama" onClose={vi.fn()} />);
    await flush();
    act(() => (document.querySelector('[aria-label="OpenCode"]') as HTMLInputElement).click());
    act(() => button("Next")!.click());
    setValue("Helper URL", "http://127.0.0.1:8790/occupancy");
    setValue("Bearer token", "helper-token");
    act(() => button("Next")!.click());
    expect((document.querySelector('[aria-label="Spark for opencode"]') as HTMLSelectElement).value).toBe("mama");
    expect((document.querySelector('[aria-label="Port for opencode"]') as HTMLInputElement).value).toBe("8000");
    act(() => button("Next")!.click());
    await act(async () => button("Check connection")!.click());
    await flush();
    const body = document.body.textContent || "";
    expect(body).toContain("3 sessions");
    expect(body).toContain("opencode: supported");
    expect(body).not.toContain("SECRET-TITLE");
    act(() => button("Next")!.click());
    expect(document.querySelector(".harness-snippet")?.textContent).toContain("OCCUPANCY_ADAPTERS=opencode");
    expect(document.querySelector(".harness-snippet")?.textContent).not.toContain("helper-token");
    await act(async () => button("Save")!.click());
    expect(saveOccupancyHelpers).toHaveBeenCalledWith([
      expect.objectContaining({
        url: "http://127.0.0.1:8790/occupancy",
        token: "helper-token",
        harnesses: ["opencode"],
        routes: [{ harness: "opencode", sparkId: "mama", port: 8000 }],
      }),
    ]);
  });

  it("removes a saved helper", async () => {
    vi.mocked(fetchOccupancyHelpers).mockResolvedValue({
      helpers: [{
        id: "mac",
        label: "Mac",
        url: "http://127.0.0.1:8790/occupancy",
        enabled: true,
        harnesses: ["omp"],
        routes: [],
        hasToken: true,
      }],
    });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<HarnessWizard open sparks={sparks} onClose={vi.fn()} />);
    await flush();
    await act(async () => button("Remove")!.click());
    expect(deleteOccupancyHelper).toHaveBeenCalledWith("mac");
  });
});
