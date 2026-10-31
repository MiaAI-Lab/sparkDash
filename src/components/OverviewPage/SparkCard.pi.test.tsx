import { describe, expect, it, vi } from "vitest";

vi.mock("../../api/client", () => ({
  fetchLaunchers: () => new Promise(() => {}),
  runLauncher: vi.fn(),
  wakeSpark: vi.fn(),
}));

import { SparkCard } from "./SparkCard";
import { makePi } from "../../testing/fixtures";
import { render } from "../../testing/render";

describe("SparkCard for Raspberry Pi", () => {
  it("shows CPU, temperature, RAM and disk instead of GPU bars", () => {
    const { container } = render(<SparkCard spark={makePi()} temperatureUnit="celsius" />);
    const labels = [...container.querySelectorAll(".ov-lbl span:first-child")].map((el) => el.textContent);
    expect(labels).toEqual(["CPU", "CPU temp", "RAM", "Disk"]);
    expect(container.textContent).toContain("Raspberry Pi");
    expect(container.textContent).toContain("Under-voltage");
    expect(container.textContent).not.toContain("VRAM");
    expect(container.textContent).not.toContain("GPU");
    expect(container.textContent).not.toContain("CPU power");
  });

  it("never offers a wake button or a false zero-watt reading", () => {
    const { container } = render(<SparkCard spark={makePi("luffy-2", false)} temperatureUnit="celsius" />);
    expect(container.textContent).toContain("Host unreachable");
    expect(container.textContent).not.toContain("Wake up");
    expect(container.textContent).not.toContain("0 W");
  });
});
