import { act } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { setLocale } from "../../i18n";
import { render } from "../../testing/render";
import { TerminalCard } from "./TerminalCard";

afterEach(async () => { await act(() => setLocale("en")); });

it("updates terminal chrome while preserving raw content, reasoning state and copy action", async () => {
  await act(() => setLocale("en"));
  const copy = vi.fn();
  const { container } = render(<TerminalCard label="raw-model" status="completed" liveTokPerSec={0} peakTokPerSec={25} content="raw answer <tag>" reasoning="raw thinking" error="raw upstream diagnostic" onCopy={copy} />);
  const toggle = container.querySelector<HTMLButtonElement>(".showcase-term__reasoning-toggle")!;
  act(() => toggle.click());
  const expanded = toggle.getAttribute("aria-expanded");
  expect(container.textContent).toContain("Completed");
  await act(() => setLocale("zh-CN"));
  expect(container.textContent).toContain("已完成");
  expect(container.textContent).toContain("raw answer <tag>");
  expect(container.textContent).toContain("raw upstream diagnostic");
  expect(toggle.getAttribute("aria-expanded")).toBe(expanded);
  act(() => container.querySelector<HTMLButtonElement>(".showcase-term__copy")!.click());
  await act(() => setLocale("en"));
  expect(container.textContent).toContain("Completed");
  expect(toggle.getAttribute("aria-expanded")).toBe(expanded);
  expect(copy).toHaveBeenCalledTimes(1);
});
