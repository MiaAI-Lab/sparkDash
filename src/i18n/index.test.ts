import { afterEach, describe, expect, it, vi } from "vitest";
import { detectLocale, i18n, LOCALE_STORAGE_KEY, normalizeLocale, setLocale } from "./index";

afterEach(async () => {
  vi.restoreAllMocks();
  await setLocale("en");
  localStorage.clear();
});

describe("language preference", () => {
  it("recognizes supported Simplified Chinese tags and the previous browser preference", () => {
    for (const tag of ["zh", "zh-CN", "zh-SG", "zh_MY", "zh-Hans", "zh-Hans-CN"]) expect(normalizeLocale(tag)).toBe("zh-CN");
    for (const tag of ["zh-TW", "zh-Hant", "zh-HK", "de", ""]) expect(normalizeLocale(tag)).toBeNull();
    expect(normalizeLocale("en-GB")).toBe("en");
  });

  it("prefers saved language over browser language and ignores unsupported saved values", () => {
    vi.spyOn(navigator, "language", "get").mockReturnValue("zh-CN");
    localStorage.setItem(LOCALE_STORAGE_KEY, "en");
    expect(detectLocale()).toBe("en");
    localStorage.setItem(LOCALE_STORAGE_KEY, "unknown");
    expect(detectLocale()).toBe("zh-CN");
  });

  it("switches immediately, updates HTML, and survives preference reads", async () => {
    await setLocale("zh-CN");
    expect(i18n.resolvedLanguage).toBe("zh-CN");
    expect(document.documentElement.lang).toBe("zh-CN");
    expect(localStorage.getItem(LOCALE_STORAGE_KEY)).toBe("zh-CN");
    expect(detectLocale()).toBe("zh-CN");
    await setLocale("en");
    expect(document.documentElement.lang).toBe("en");
  });

  it("keeps switching when storage access throws", async () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    await expect(setLocale("zh-CN")).resolves.toBeUndefined();
    expect(document.documentElement.lang).toBe("zh-CN");
    expect(() => detectLocale()).not.toThrow();
  });
});

describe("English source and plain i18next formatting", () => {
  it("falls back to the English catalog when a Chinese entry is unavailable", async () => {
    i18n.addResourceBundle("en", "fixture", { greeting: "Hello, {{name}}", items_one: "{{count}} item", items_other: "{{count}} items" });
    try {
      await setLocale("zh-CN");
      expect(i18n.t("fixture:greeting", { name: "GPU <1>" })).toBe("Hello, GPU <1>");
      await setLocale("en");
      expect(i18n.t("fixture:items", { count: 1 })).toBe("1 item");
      expect(i18n.t("fixture:items", { count: 2 })).toBe("2 items");
    } finally {
      i18n.removeResourceBundle("en", "fixture");
    }
  });
});
