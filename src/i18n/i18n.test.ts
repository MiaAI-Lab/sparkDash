import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { LOCALE_STORAGE_KEY, detectLocale, normalizeLocale } from "./detect";
import { activeLocale, i18next, initI18n, setLocale } from "./index";
import { catalogLocales, catalogNamespaces, loadLocaleCatalogs } from "./resources";

describe("locale detection", () => {
  beforeEach(() => localStorage.clear());

  it("maps simplified-Chinese tags to zh-Hans", () => {
    expect(normalizeLocale("zh")).toBe("zh-Hans");
    expect(normalizeLocale("zh-CN")).toBe("zh-Hans");
    expect(normalizeLocale("zh-Hans")).toBe("zh-Hans");
  });

  it("leaves traditional Chinese and other languages on English", () => {
    expect(normalizeLocale("zh-TW")).toBeNull();
    expect(normalizeLocale("zh-Hant")).toBeNull();
    expect(normalizeLocale("de")).toBeNull();
    expect(normalizeLocale("")).toBeNull();
  });

  it("prefers the stored choice and ignores junk", () => {
    localStorage.setItem(LOCALE_STORAGE_KEY, "zh-Hans");
    expect(detectLocale()).toBe("zh-Hans");
    localStorage.setItem(LOCALE_STORAGE_KEY, "klingon");
    expect(detectLocale()).toBe("en");
  });
});

describe("catalog wiring", () => {
  // Vitest transforms lazy JSON modules on first import. Prepare that compiler
  // work in setup; the tests still call the real loader and use default deadlines.
  beforeAll(async () => {
    await loadLocaleCatalogs("zh-Hans");
  });

  beforeEach(() => {
    localStorage.clear();
    initI18n({ lng: "en" });
  });

  afterEach(async () => {
    i18next.removeResourceBundle("zh-Hans", "i18ntest");
    await i18next.changeLanguage("en");
    localStorage.clear();
    document.documentElement.lang = "en";
  });

  it("registers the shipped catalogs", () => {
    expect(catalogLocales()).toEqual(["zh-Hans"]);
    expect(catalogNamespaces("zh-Hans")).toContain("shell");
  });

  it("loads a catalog from disk", async () => {
    const bundles = await loadLocaleCatalogs("zh-Hans");
    expect(Object.keys(bundles)).toContain("shell");
  });

  it("returns the inline English default by default", () => {
    expect(i18next.t("shell.nav.overview", "Overview")).toBe("Overview");
    expect(activeLocale()).toBe("en");
  });

  it("switches to the zh-Hans catalog, remembers it and sets <html lang>", async () => {
    await setLocale("zh-Hans");
    expect(i18next.t("shell.nav.overview", "Overview")).toBe("总览");
    expect(activeLocale()).toBe("zh-Hans");
    expect(document.documentElement.lang).toBe("zh-Hans");
    expect(localStorage.getItem(LOCALE_STORAGE_KEY)).toBe("zh-Hans");
  });

  it("formats ICU plurals", async () => {
    i18next.addResourceBundle("zh-Hans", "i18ntest", {
      items: "{count, plural, one {# 项} other {# 项}}",
    });
    await i18next.changeLanguage("zh-Hans");
    expect(i18next.t("i18ntest.items", { count: 2 })).toBe("2 项");
  });
});
