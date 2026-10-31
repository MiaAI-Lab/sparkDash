import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchLaunchers = vi.fn();
const runLauncher = vi.fn();
vi.mock("../../api/client", () => ({
  fetchLaunchers: (...a: unknown[]) => fetchLaunchers(...a),
  runLauncher: (...a: unknown[]) => runLauncher(...a),
  addLauncher: vi.fn(),
  updateLauncher: vi.fn(),
}));

import { ModelLauncher } from "./ModelLauncher";
import { _resetLauncherCache } from "../../hooks/launcherCache";
import { setLocale } from "../../i18n";
import { makeSpark } from "../../testing/fixtures";
import { flush, render } from "../../testing/render";

const launcher = { id: "raw-launcher", name: "Raw Model Q4", dir: "/models/raw", startScript: "start.sh", stopScript: "stop.sh", port: 8000, notes: "" };

describe("ModelLauncher locale changes", () => {
  beforeEach(async () => {
    _resetLauncherCache();
    fetchLaunchers.mockReset();
    runLauncher.mockReset();
    await setLocale("en");
  });
  afterEach(async () => {
    await act(() => setLocale("en"));
  });

  it("keeps a pending inline launch and selected launcher through a locale change without extra requests", async () => {
    fetchLaunchers.mockResolvedValue({ launchers: [launcher], job: null, statuses: { [launcher.id]: "stopped" } });
    let resolveRun!: () => void;
    runLauncher.mockImplementation(() => new Promise<void>((resolve) => { resolveRun = resolve; }));
    const { container } = render(<ModelLauncher spark={makeSpark("locale-launcher")} />);
    await flush();
    const start = [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Start")!;
    await act(async () => start.click());
    expect(runLauncher).toHaveBeenCalledWith("locale-launcher", "raw-launcher", "start");
    expect(start.disabled).toBe(true);
    expect(fetchLaunchers).toHaveBeenCalledTimes(1);

    await act(async () => setLocale("zh-CN"));
    expect(container.textContent).toContain("Raw Model Q4");
    expect(container.textContent).toContain("正在启动…");
    expect(runLauncher).toHaveBeenCalledTimes(1);
    expect(fetchLaunchers).toHaveBeenCalledTimes(1);

    await act(async () => { resolveRun(); });
    expect(runLauncher).toHaveBeenCalledTimes(1);
    expect(fetchLaunchers).toHaveBeenCalledTimes(1);
  });
});
