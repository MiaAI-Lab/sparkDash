import { afterEach, describe, expect, it, vi } from "vitest";
import { activeLocale, bootstrapI18n, i18next, setLocale } from "./index";
import { LOCALE_STORAGE_KEY } from "./detect";
import { loadLocaleCatalogs } from "./resources";

// setup.ts initializes the regular module before mocks are registered.
// Reload this module so its loader reference uses the deferred test loader.
vi.hoisted(() => vi.resetModules());

vi.mock("./resources", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./resources")>();
  return { ...actual, loadLocaleCatalogs: vi.fn(actual.loadLocaleCatalogs) };
});

afterEach(async () => {
  await setLocale("en", { persist: false });
  localStorage.clear();
});

describe("asynchronous language selection", () => {
  // Keep these steps together: the first failure must leave the loader retryable,
  // and the successful retry must not replace a newer English selection.
  it("can retry a failed startup download and preserves the latest selection", async () => {
    vi.mocked(loadLocaleCatalogs).mockRejectedValueOnce(new Error("offline"));
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    localStorage.setItem(LOCALE_STORAGE_KEY, "zh-Hans");
    bootstrapI18n();
    await vi.waitFor(() => expect(warning).toHaveBeenCalledOnce());
    expect(activeLocale()).toBe("en");
    expect(document.documentElement.lang).toBe("en");
    // A temporary failure must not erase the saved preference.
    expect(localStorage.getItem(LOCALE_STORAGE_KEY)).toBe("zh-Hans");

    let finish!: (bundles: Awaited<ReturnType<typeof loadLocaleCatalogs>>) => void;
    vi.mocked(loadLocaleCatalogs).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const chinese = setLocale("zh-Hans");
    await setLocale("en");
    finish({ shell: { nav: { overview: "总览" } } });
    await chinese;
    expect(activeLocale()).toBe("en");
    expect(document.documentElement.lang).toBe("en");
    expect(localStorage.getItem(LOCALE_STORAGE_KEY)).toBe("en");
    expect(i18next.t("shell.nav.overview", "Overview")).toBe("Overview");

    await setLocale("zh-Hans");
    expect(activeLocale()).toBe("zh-Hans");
    expect(i18next.t("shell.nav.overview", "Overview")).toBe("总览");
    expect(loadLocaleCatalogs).toHaveBeenCalledTimes(2);
  });
});
