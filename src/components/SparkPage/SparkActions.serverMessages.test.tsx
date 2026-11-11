import { act } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { wakeSpark, shutdownSpark } from "../../api/client";
import { ApiRequestError } from "../../api/types";
import { setLocale } from "../../i18n";
import { makeSpark } from "../../testing/fixtures";
import { flush, render } from "../../testing/render";
import { SparkActions } from "./SparkActions";

vi.mock("../../api/client", () => ({ wakeSpark: vi.fn(), shutdownSpark: vi.fn() }));
afterEach(async () => { await act(() => setLocale("en")); vi.resetAllMocks(); });

it("rerenders stored API descriptors without repeating a power action", async () => {
  await act(() => setLocale("en"));
  vi.mocked(wakeSpark).mockRejectedValue(new ApiRequestError("Spark not found", { error: { key: "server.error.sparkNotFound" } }));
  const spark = { ...makeSpark("raw-host", false), kind: "host" as const };
  const { container } = render(<SparkActions spark={spark} />);
  act(() => container.querySelector<HTMLButtonElement>("button")!.click());
  await flush();
  expect(container.textContent).toContain("Spark not found");
  await act(() => setLocale("zh-CN"));
  expect(container.textContent).toContain("找不到 Spark");
  await act(() => setLocale("en"));
  expect(container.textContent).toContain("Spark not found");
  expect(wakeSpark).toHaveBeenCalledExactlyOnceWith("raw-host");
});

it("keeps translated action controls alongside server descriptors", async () => {
  await act(() => setLocale("en"));
  const { container } = render(<SparkActions spark={makeSpark("raw-model-host")} onEdit={() => {}} />);
  expect(container.textContent).toContain("Edit");
  expect(container.textContent).toContain("Shut down");
  await act(() => setLocale("zh-CN"));
  expect(container.textContent).toContain("编辑");
  expect(container.textContent).toContain("关机");
  expect(container.textContent).not.toContain("Shut down");
  expect(shutdownSpark).not.toHaveBeenCalled();
  expect(wakeSpark).not.toHaveBeenCalled();
});
