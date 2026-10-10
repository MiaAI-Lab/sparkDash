// Locale detection + persistence.
//
// Same shape as the theme switcher in index.html: an explicit user choice in
// localStorage wins, the browser's preference is the default, English is the
// last resort. Only locales that actually ship a catalog are ever returned, so
// an unknown language shows the in-source English defaults instead of a
// half-translated mix.

export const LOCALE_STORAGE_KEY = "sparkdash-locale";
export const FALLBACK_LOCALE = "en";
export const SUPPORTED_LOCALES = ["en", "zh-Hans"] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];

// Exact (lower-cased) BCP47 tags we map to a shipped catalog. Simplified
// Chinese variants all resolve to zh-Hans. Traditional Chinese (zh-Hant,
// zh-TW, zh-HK) is deliberately NOT mapped: we ship no zh-Hant catalog, so
// those users keep English rather than being served simplified Chinese.
const TAG_ALIASES: Record<string, Locale> = {
  en: "en",
  "en-us": "en",
  "en-gb": "en",
  zh: "zh-Hans",
  "zh-hans": "zh-Hans",
  "zh-cn": "zh-Hans",
  "zh-sg": "zh-Hans",
  "zh-my": "zh-Hans",
};

export function normalizeLocale(input: string | null | undefined): Locale | null {
  if (!input) return null;
  return TAG_ALIASES[input.trim().toLowerCase()] ?? null;
}

// navigator can be absent (node) and localStorage can throw (private mode),
// so every access here is defensive.
function browserLanguages(): string[] {
  if (typeof navigator === "undefined") return [];
  const langs = navigator.languages;
  if (Array.isArray(langs) && langs.length > 0) return [...langs];
  return navigator.language ? [navigator.language] : [];
}

export function readStoredLocale(): Locale | null {
  try {
    return normalizeLocale(localStorage.getItem(LOCALE_STORAGE_KEY));
  } catch {
    return null;
  }
}

export function storeLocale(locale: Locale | null): void {
  try {
    if (locale) localStorage.setItem(LOCALE_STORAGE_KEY, locale);
    else localStorage.removeItem(LOCALE_STORAGE_KEY);
  } catch {
    /* storage is optional */
  }
}

export function detectLocale(): Locale {
  const stored = readStoredLocale();
  if (stored) return stored;
  for (const tag of browserLanguages()) {
    const match = normalizeLocale(tag);
    if (match) return match;
  }
  return FALLBACK_LOCALE;
}

export function applyHtmlLang(locale: string): void {
  if (typeof document !== "undefined") document.documentElement.lang = locale;
}
