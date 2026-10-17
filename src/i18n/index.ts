import { createInstance } from "i18next";
import { initReactI18next } from "react-i18next";
import enSettings from "../locales/en/settings.json";
import zhSettings from "../locales/zh-CN/settings.json";
import enLanguage from "../locales/en/language.json";
import zhLanguage from "../locales/zh-CN/language.json";

export type Locale = "en" | "zh-CN";
export const LOCALE_STORAGE_KEY = "sparkdash-locale";

export function normalizeLocale(value: string | null | undefined): Locale | null {
  if (!value) return null;
  const tag = value.toLowerCase().replace(/_/g, "-");
  if (tag === "en" || tag.startsWith("en-")) return "en";
  if (tag === "zh" || tag === "zh-cn" || tag === "zh-sg" || tag === "zh-my" || tag === "zh-hans" || tag.startsWith("zh-hans-")) return "zh-CN";
  return null;
}

export function detectLocale(): Locale {
  try {
    const stored = normalizeLocale(localStorage.getItem(LOCALE_STORAGE_KEY));
    if (stored) return stored;
  } catch { /* Browser storage is optional. */ }
  return normalizeLocale(typeof navigator === "undefined" ? null : navigator.language) ?? "en";
}

// One bundled loader for this small foundation. English catalogs are the source
// of truth; subsequent pages add namespaces rather than parallel loaders.
export const i18n = createInstance();
void i18n.use(initReactI18next).init({
  resources: {
    en: { settings: enSettings, language: enLanguage },
    "zh-CN": { settings: zhSettings, language: zhLanguage },
  },
  lng: detectLocale(),
  fallbackLng: "en",
  supportedLngs: ["en", "zh-CN"],
  load: "currentOnly",
  defaultNS: "settings",
  ns: ["settings", "language"],
  interpolation: { escapeValue: false },
  returnEmptyString: false,
  initAsync: false,
});

function updateDocumentLanguage() {
  if (typeof document !== "undefined") document.documentElement.lang = i18n.resolvedLanguage ?? "en";
}
i18n.on("languageChanged", updateDocumentLanguage);
updateDocumentLanguage();

export async function setLocale(locale: Locale): Promise<void> {
  await i18n.changeLanguage(locale);
  try { localStorage.setItem(LOCALE_STORAGE_KEY, locale); } catch { /* Switching still works without storage. */ }
}
