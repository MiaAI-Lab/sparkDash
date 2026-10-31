import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../../i18n";
import { makeSpark } from "../../testing/fixtures";
import { render } from "../../testing/render";
import { AppSidebar } from "./AppSidebar";
import { MobileTabBar } from "./MobileTabBar";

afterEach(async () => {
  await act(async () => setLocale("en"));
  localStorage.clear();
});

describe("shell navigation localization", () => {
  it("round-trips the sidebar locale without changing routes, callbacks, or Spark names", async () => {
    const onSelect = vi.fn();
    const spark = makeSpark("alpha");
    const { container } = render(
      <AppSidebar sparks={[spark]} activeId={null} onSelect={onSelect} onAdd={() => {}} onOpenSettings={() => {}} onOpenSearch={() => {}} connected />
    );

    const overview = container.querySelector<HTMLAnchorElement>('a[href="/"].rail-item')!;
    expect(overview.textContent).toContain("Overview");
    expect(container.textContent).toContain("Spark alpha");
    act(() => overview.click());
    expect(onSelect).toHaveBeenLastCalledWith("__overview__");
    act(() => overview.dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: true })));
    expect(onSelect).toHaveBeenCalledTimes(1);

    await act(async () => setLocale("zh-CN"));
    expect(overview.getAttribute("href")).toBe("/");
    expect(overview.textContent).toContain("总览");
    expect(container.textContent).toContain("Spark alpha");

    await act(async () => setLocale("en"));
    expect(overview.textContent).toContain("Overview");
  });

  it("keeps the mobile Spark sheet open across a locale switch and preserves its callback", async () => {
    const onSelect = vi.fn();
    const { container } = render(
      <MobileTabBar sparks={[makeSpark("alpha")]} activeId={null} onSelect={onSelect} onAdd={() => {}} onOpenSettings={() => {}} />
    );
    const sparksTab = [...container.querySelectorAll("button")].find((button) => button.textContent === "Sparks")!;
    act(() => sparksTab.click());
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();

    await act(async () => setLocale("zh-CN"));
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(document.querySelector('[role="dialog"]')?.getAttribute("aria-label")).toBe("选择 Spark");
    expect(document.body.textContent).toContain("Spark alpha");

    const spark = [...document.querySelectorAll<HTMLButtonElement>(".sheet .rail-item")].find((button) => button.textContent?.includes("Spark alpha"))!;
    act(() => spark.click());
    expect(onSelect).toHaveBeenCalledWith("alpha");
  });
});
