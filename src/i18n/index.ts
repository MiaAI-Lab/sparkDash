import i18next, { type i18n as I18nInstance } from "i18next";
import { initReactI18next } from "react-i18next";
import ICU from "i18next-icu";
import {
  FALLBACK_LOCALE,
  SUPPORTED_LOCALES,
  applyHtmlLang,
  detectLocale,
  normalizeLocale,
  storeLocale,
  type Locale,
} from "./detect";
import { loadLocaleCatalogs } from "./resources";

// One namespace per product area; the directory layout of src/components
// mirrors it, which keeps catalogs reviewable and lets a locale be extended
// area by area.
//   shell    — sidebar, topbar, command palette, mobile tab bar
//   overview — fleet overview page
//   spark    — single Spark page (panels + bench dialogs)
//   bench    — standalone benchmark pages
//   showcase / activity / tokens / energy — the matching pages
//   common   — strings shared by more than one area
//   health / server — strings that originate on the server
export const NAMESPACES = [
  "common",
  "shell",
  "overview",
  "spark",
  "bench",
  "showcase",
  "activity",
  "tokens",
  "energy",
  "health",
  "server",
] as const;
export type Namespace = (typeof NAMESPACES)[number];
export const DEFAULT_NAMESPACE: Namespace = "common";

let initialized = false;
let reactBound = false;
const catalogPromises = new Map<string, Promise<void>>();

export interface InitI18nOptions {
  /** Force the startup language (tests pin this to "en"). */
  lng?: Locale;
}

/**
 * Initialise the singleton i18next instance. Idempotent: the app calls it from
 * bootstrapI18n(), the test setup calls it once with lng "en" so the existing
 * suite keeps asserting on the in-source English defaults.
 */
export function initI18n(options: InitI18nOptions = {}): I18nInstance {
  if (initialized) return i18next;
  initialized = true;
  if (!reactBound) {
    reactBound = true;
    i18next.use(ICU).use(initReactI18next);
  }
  void i18next.init({
    lng: options.lng ?? FALLBACK_LOCALE,
    fallbackLng: FALLBACK_LOCALE,
    supportedLngs: [...SUPPORTED_LOCALES],
    ns: [...NAMESPACES],
    defaultNS: DEFAULT_NAMESPACE,
    resources: {},
    // The first dotted segment of a key is its namespace: t("shell.nav.overview")
    // resolves inside src/locales/<locale>/shell.json at nav › overview. This
    // keeps call sites readable without repeating "shell:" everywhere.
    nsSeparator: ".",
    keySeparator: ".",
    // ICU is the message format (i18next-icu): placeholders are {name},
    // plurals are {count, plural, one {…} other {…}}. A catalog that is not
    // loaded yet simply falls through to the inline English default.
    interpolation: { escapeValue: false },
    returnNull: false,
  });
  return i18next;
}

function ensureCatalogs(locale: Locale): Promise<void> {
  const pending = catalogPromises.get(locale);
  if (pending) return pending;
  const load = loadLocaleCatalogs(locale).then((bundles) => {
    for (const [namespace, data] of Object.entries(bundles)) {
      i18next.addResourceBundle(locale, namespace, data, true, true);
    }
  });
  catalogPromises.set(locale, load);
  return load;
}

/** The locale i18next is actually using, canonicalised to our own ids. */
export function activeLocale(): Locale {
  const raw = String(i18next.resolvedLanguage ?? i18next.language ?? FALLBACK_LOCALE);
  return SUPPORTED_LOCALES.find((locale) => locale.toLowerCase() === raw.toLowerCase()) ?? FALLBACK_LOCALE;
}

/**
 * Switch language: load the catalog for that locale (if any), remember the
 * choice and update <html lang>. Safe to call before initI18n().
 */
export async function setLocale(locale: Locale, options: { persist?: boolean } = {}): Promise<void> {
  initI18n();
  const { persist = true } = options;
  if (locale !== FALLBACK_LOCALE) await ensureCatalogs(locale);
  if (persist) storeLocale(locale);
  await i18next.changeLanguage(locale);
  applyHtmlLang(locale);
}

/**
 * Called once from main.tsx before the React tree mounts. Renders immediately
 * with English defaults; a non-English catalog is fetched in the background
 * and swapped in as soon as it is available.
 */
export function bootstrapI18n(): void {
  initI18n();
  const target = detectLocale();
  applyHtmlLang(target);
  if (target === FALLBACK_LOCALE) return;
  void setLocale(target, { persist: false });
}

export { i18next };
export { normalizeLocale };
export type { Locale };
