import i18next from "i18next";
import { initReactI18next } from "react-i18next";
import { en } from "./locales/en";
import { zhCN } from "./locales/zh-CN";

/**
 * Minimal i18n for sparkDash: English source strings are the keys, so missing
 * translations fall back to the English UI automatically. The language choice
 * lives in localStorage ("sparkdash-lang") and is announced on the window as a
 * `sparkdash:language` event, mirroring how the theme switch propagates.
 */

export const LANG_STORAGE_KEY = "sparkdash-lang";
export const LANGUAGE_EVENT = "sparkdash:language";

export type AppLanguage = "en" | "zh-CN";

export const LANGUAGES: { code: AppLanguage; label: string }[] = [
  { code: "en", label: "English" },
  { code: "zh-CN", label: "中文（简体）" },
];

export function getSavedLanguage(): AppLanguage {
  try {
    const saved = localStorage.getItem(LANG_STORAGE_KEY);
    if (saved === "en" || saved === "zh-CN") return saved;
  } catch {
    /* private mode */
  }
  return "en";
}

export function setAppLanguage(lang: AppLanguage) {
  try {
    localStorage.setItem(LANG_STORAGE_KEY, lang);
  } catch {
    /* private mode */
  }
  void i18next.changeLanguage(lang);
  window.dispatchEvent(new CustomEvent(LANGUAGE_EVENT, { detail: lang }));
}

void i18next.use(initReactI18next).init({
  lng: getSavedLanguage(),
  fallbackLng: "en",
  defaultNS: "app",
  resources: {
    en: { app: en },
    "zh-CN": { app: zhCN },
  },
  interpolation: { escapeValue: false },
  // Resources are bundled inline: init completes synchronously. Without these,
  // react-i18next's default Suspense gate holds the whole tree unrendered.
  react: { useSuspense: false },
  initImmediate: false,
});

window.addEventListener(LANGUAGE_EVENT, (e) => {
  const lang = (e as CustomEvent).detail as AppLanguage | undefined;
  if (lang === "en" || lang === "zh-CN") void i18next.changeLanguage(lang);
});

export { i18next };

/**
 * Module-scope translator for components that render polled data (they re-render
 * every refresh, so they pick up language switches without a hook subscription).
 * Bind once here instead of threading `const { t } = useTranslation()` through
 * every component — identical key namespace, same instance as the hook.
 */
export const t = i18next.t.bind(i18next);
