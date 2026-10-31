import { act } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { wakeSpark } from "../../api/client";
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
