import { describe, expect, it, vi } from "vitest";

vi.mock("../../api/client", () => ({
  updateSpark: vi.fn(),
  refreshSparkMetric: vi.fn(),
  addLlmPort: vi.fn(),
  removeLlmPort: vi.fn(),
  fetchLaunchers: () => new Promise(() => {}),
  runLauncher: vi.fn(),
  wakeSpark: vi.fn(),
  shutdownSpark: vi.fn(),
}));

import { SparkPage } from "./SparkPage";
import { makePi } from "../../testing/fixtures";
import { render } from "../../testing/render";

describe("SparkPage for Raspberry Pi", () => {
  it("shows the board panel and hides GPU, models, LLM and CPU power", () => {
    const { container } = render(<SparkPage spark={makePi()} temperatureUnit="celsius" />);
    expect(container.querySelector(".panel-pi")).not.toBeNull();
    expect(container.querySelector(".panel-gpu")).toBeNull();
    expect(container.textContent).toContain("Raspberry Pi");
    expect(container.textContent).not.toContain("CPU power");
    expect(container.textContent).not.toContain("Models");
    expect(container.textContent).not.toContain("LLM");
  });
});
