import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OpenAccessChip } from "../OpenAccessChip";
import { ThemeSwitch } from "../ThemeSwitch";
import { ErrorBanner } from "../ui/ErrorBanner";
import { ConnectionBanner } from "../ui/ConnectionBanner";
import { i18n, setLocale } from "../../i18n";
import { render } from "../../testing/render";
import { CommandPalette, type PaletteCommand } from "./CommandPalette";
import { InstallPrompt } from "./InstallPrompt";

const commands: PaletteCommand[] = [{ id: "overview", group: "Go to", label: "Overview", run: () => {} }];

beforeEach(async () => {
  localStorage.clear();
  await setLocale("en");
});

afterEach(async () => {
  vi.restoreAllMocks();
  await act(async () => setLocale("en"));
  localStorage.clear();
});

describe("shared shell i18n", () => {
  it("keeps a valid keyboard selection when localized search results shrink", async () => {
    const run = vi.fn();
    const original = [
      { id: "one", group: "Go to", label: "页面一", run },
      { id: "two", group: "Go to", label: "页面二", run: vi.fn() },
    ];
    const { root } = render(<CommandPalette open onClose={() => {}} commands={original} />);
    const input = document.querySelector<HTMLInputElement>('[role="combobox"]')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "页面");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
    act(() => root.render(<CommandPalette open onClose={() => {}} commands={[original[0], { ...original[1], label: "Page two" }]} />));
    expect(input.value).toBe("页面");
    expect(document.querySelector('[role="option"][aria-selected="true"]')?.id).toBe(input.getAttribute("aria-activedescendant"));
    act(() => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(run).toHaveBeenCalledOnce();
  });

  it("switches palette copy without clearing its typed query", async () => {
    render(<CommandPalette open onClose={() => {}} commands={commands} />);
    const input = document.querySelector<HTMLInputElement>('input[aria-label="Search commands"]')!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    act(() => {
      setter.call(input, "over");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });

    await act(async () => setLocale("zh-CN"));

    expect(i18n.resolvedLanguage).toBe("zh-CN");
    expect(input.value).toBe("over");
    expect(document.querySelector('[role="dialog"]')?.getAttribute("aria-label")).toBe("命令面板");
    expect(document.querySelector('[role="option"]')?.textContent).toContain("Overview");
  });

  it("localizes shell controls without changing the selected theme or dispatching a theme operation", async () => {
    const onThemeChange = vi.fn();
    window.addEventListener("sparkdash:set-theme", onThemeChange);
    try {
      const { container } = render(<ThemeSwitch />);
      expect(container.querySelector("button")?.getAttribute("title")).toBe("Theme: dark");
      onThemeChange.mockClear();

      await act(async () => setLocale("zh-CN"));

      expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
      expect(localStorage.getItem("sparkdash-theme")).toBe("dark");
      expect(onThemeChange).not.toHaveBeenCalled();
      expect(container.querySelector("button")?.getAttribute("title")).toBe("主题：深色");
    } finally {
      window.removeEventListener("sparkdash:set-theme", onThemeChange);
    }
  });

  it("keeps raw snapshot and action diagnostics unchanged while local banner controls switch", async () => {
    const diagnostic = "upstream connection failed\\noriginal detail <raw>";
    const dismiss = vi.fn();
    const connection = render(
      <ConnectionBanner connected={false} lastValidSnapshotAt={10_000} snapshotError={diagnostic} now={21_000} stale />,
    ).container;
    const error = render(<ErrorBanner message={diagnostic} onDismiss={dismiss} />).container;

    await act(async () => setLocale("zh-CN"));

    expect(connection.textContent).toContain(diagnostic);
    expect(error.querySelector('[role="alert"]')?.textContent).toContain(diagnostic);
    expect(error.querySelector("button")?.textContent).toBe("关闭");
    act(() => error.querySelector<HTMLButtonElement>("button")!.click());
    expect(dismiss).toHaveBeenCalledOnce();
  });

  it("preserves install and open-access state across a locale switch", async () => {
    const prompt = vi.fn(async () => {});
    const installEvent = Object.assign(new Event("beforeinstallprompt", { cancelable: true }), {
      prompt,
      userChoice: Promise.resolve({ outcome: "dismissed" as const }),
    });
    const install = render(<InstallPrompt />).container;
    const access = render(<OpenAccessChip authMode="open-remote" />).container;
    act(() => window.dispatchEvent(installEvent));
    act(() => access.querySelector<HTMLButtonElement>(".open-access-chip")!.click());

    await act(async () => setLocale("zh-CN"));

    expect(install.querySelector('[role="dialog"]')?.getAttribute("aria-label")).toBe("安装 sparkDash");
    expect(install.textContent).toContain("安装");
    expect(prompt).not.toHaveBeenCalled();
    expect(access.querySelector('[role="dialog"]')?.getAttribute("aria-label")).toBe("开放访问");
    expect(access.querySelector(".open-access-popover")?.textContent).toContain("SPARKDASH_TOKEN");
  });
});
