import { act } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { setLocale } from "../../i18n";
import { render } from "../../testing/render";
import { CardPreview } from "./CardPreview";

afterEach(async () => {
  await act(() => setLocale("en"));
});

it("translates the open preview and keeps its image and actions available", async () => {
  const onClose = vi.fn();
  const onDownload = vi.fn();
  const onCopy = vi.fn();
  const url = "blob:http://localhost/example";
  const { container } = render(<CardPreview url={url} label="Benchmark share card" imgAlt="Benchmark result"
    hint={null} onClose={onClose} onDownload={onDownload} onCopy={onCopy} />);
  const dialog = container.querySelector('[role="dialog"]')!;
  expect(dialog.querySelector("h2")?.textContent).toBe("Share card");
  await act(() => setLocale("zh-CN"));
  expect(dialog.querySelector("h2")?.textContent).toBe("分享卡片");
  expect(dialog.querySelector("img")?.getAttribute("src")).toBe(url);
  const button = (label: string) => [...dialog.querySelectorAll("button")].find((el) => el.textContent === label)!;
  for (const label of ["复制图片", "下载 PNG", "关闭"]) act(() => button(label).click());
  expect(dialog.querySelector('[aria-label="关闭分享卡片"]')).not.toBeNull();
  expect(onCopy).toHaveBeenCalledOnce();
  expect(onDownload).toHaveBeenCalledOnce();
  expect(onClose).toHaveBeenCalledOnce();
});
