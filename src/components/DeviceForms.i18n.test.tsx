import { act } from "react";
import { afterEach, beforeEach, expect, it } from "vitest";
import { AddSparkDialog } from "./AddSparkDialog";
import { i18n, setLocale } from "../i18n";
import { render } from "../testing/render";

beforeEach(async () => {
  await setLocale("en");
});

afterEach(async () => {
  await act(() => setLocale("en"));
});

it("localizes device form labels and accessibility text without changing its draft", async () => {
  render(<AddSparkDialog open onClose={() => {}} onAdded={() => {}} />);

  expect(document.querySelector("#add-spark-title")?.textContent).toBe("Add Spark/GPU Host");
  expect(document.querySelector('[aria-label="Progress"]')).not.toBeNull();
  expect(document.querySelector(".stepper")?.textContent).toContain("Connect");

  await act(async () => { await i18n.changeLanguage("zh-CN"); });

  expect(document.querySelector("#add-spark-title")?.textContent).toBe("添加 Spark / GPU 主机");
  expect(document.querySelector('[aria-label="进度"]')).not.toBeNull();
  expect(document.querySelector(".stepper")?.textContent).toContain("连接");
});
