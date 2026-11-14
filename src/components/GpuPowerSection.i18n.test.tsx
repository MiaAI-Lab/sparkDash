import { act } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { fetchGpuPower, setGpuPower } from "../api/client";
import type { GpuPowerStatus } from "../api/types";
import { setLocale } from "../i18n";
import { flush, render } from "../testing/render";
import { GpuPowerSection } from "./GpuPowerSection";

vi.mock("../api/client", () => ({ fetchGpuPower: vi.fn(), setGpuPower: vi.fn() }));

const status: GpuPowerStatus = {
  supported: true,
  cards: [{ index: 0, uuid: "GPU-example", name: "NVIDIA GeForce RTX 4090", limitW: 255, enforcedW: 250,
    defaultW: 450, minW: 150, maxW: 450, adjustable: true, bootW: null }],
  sudo: "yes",
  passwordAllowed: true,
  service: { installed: false, enabled: null, active: null },
  otherServices: ["maya-example.service"],
};

const button = (scope: HTMLElement, label: string) =>
  [...scope.querySelectorAll("button")].find((node) => node.textContent === label)!;

afterEach(async () => {
  await act(() => setLocale("en"));
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});

it("keeps the edited watts, reboot confirmation and API payload when the locale changes", async () => {
  vi.mocked(fetchGpuPower).mockResolvedValue(status);
  vi.mocked(setGpuPower).mockResolvedValue({ success: true, limits: [{ uuid: "GPU-example", watts: 450, index: 0 }], persist: true });
  const confirmInstall = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);
  vi.stubGlobal("confirm", confirmInstall);
  const { container } = render(<GpuPowerSection sparkId="gpu-host" />);
  await flush();
  act(() => button(container, "Fill in defaults").click());
  act(() => (container.querySelector('input[type="checkbox"]') as HTMLInputElement).click());
  await act(() => setLocale("zh-CN"));
  expect(container.textContent).toContain("GPU 功率上限");
  expect(container.textContent).toContain("maya-example.service");
  expect(container.querySelector("code")?.textContent).toBe("nvidia-smi -i CARD -pl WATTS");
  expect(container.querySelector<HTMLInputElement>('input[type="number"]')?.value).toBe("450");
  expect(fetchGpuPower).toHaveBeenCalledTimes(1);
  await act(async () => button(container, "应用").click());
  expect(confirmInstall.mock.calls[0][0]).toContain("安装系统服务");
  expect(setGpuPower).not.toHaveBeenCalled();
  await act(async () => button(container, "应用").click());
  expect(setGpuPower).toHaveBeenCalledExactlyOnceWith("gpu-host", { limits: [{ uuid: "GPU-example", watts: 450 }], persist: true });
  expect(container.textContent).toContain("已设置 GPU 0 450 W，重启后保留。");
  await act(() => setLocale("en"));
  expect(container.textContent).toContain("GPU 0 450 W, kept after reboot.");
});

it("translates the HTTP explanation while keeping the generated command and apply restriction", async () => {
  vi.mocked(fetchGpuPower).mockResolvedValue({ ...status, sudo: "no", passwordAllowed: false });
  const { container } = render(<GpuPowerSection sparkId="gpu-host" />);
  await flush();
  await act(() => setLocale("zh-CN"));
  expect(container.textContent).toContain("允许通过明文 HTTP 输入 sudo 密码");
  expect(container.querySelector("textarea")?.getAttribute("aria-label")).toBe("在主机上运行的命令");
  expect(container.querySelector("textarea")?.value).toBe("sudo nvidia-smi -i GPU-example -pl 255");
  expect(button(container, "应用").disabled).toBe(true);
  expect(setGpuPower).not.toHaveBeenCalled();
});
