import { createInstance } from "i18next";
import { initReactI18next } from "react-i18next";
import enSettings from "../locales/en/settings.json";
import zhSettings from "../locales/zh-CN/settings.json";
import zhTWSettings from "../locales/zh-TW/settings.json";
import enLanguage from "../locales/en/language.json";
import zhLanguage from "../locales/zh-CN/language.json";
import zhTWLanguage from "../locales/zh-TW/language.json";
import enShell from "../locales/en/shell.json";
import zhShell from "../locales/zh-CN/shell.json";
import zhTWShell from "../locales/zh-TW/shell.json";
import enOverview from "../locales/en/overview.json";
import zhOverview from "../locales/zh-CN/overview.json";
import zhTWOverview from "../locales/zh-TW/overview.json";
import enSpark from "../locales/en/spark.json";
import zhSpark from "../locales/zh-CN/spark.json";
import zhTWSpark from "../locales/zh-TW/spark.json";
import enStatistics from "../locales/en/statistics.json";
import zhStatistics from "../locales/zh-CN/statistics.json";
import zhTWStatistics from "../locales/zh-TW/statistics.json";
import enActivity from "../locales/en/activity.json";
import zhActivity from "../locales/zh-CN/activity.json";
import zhTWActivity from "../locales/zh-TW/activity.json";
import enDevices from "../locales/en/devices.json";
import zhDevices from "../locales/zh-CN/devices.json";
import zhTWDevices from "../locales/zh-TW/devices.json";
import enHardware from "../locales/en/hardware.json";
import zhHardware from "../locales/zh-CN/hardware.json";
import zhTWHardware from "../locales/zh-TW/hardware.json";
import enBenchmarks from "../locales/en/benchmarks.json";
import zhBenchmarks from "../locales/zh-CN/benchmarks.json";
import zhTWBenchmarks from "../locales/zh-TW/benchmarks.json";
import enTooleval from "../locales/en/tooleval.json";
import zhTooleval from "../locales/zh-CN/tooleval.json";
import zhTWTooleval from "../locales/zh-TW/tooleval.json";
import enToolMessages from "../locales/en/toolMessages.json";
import zhToolMessages from "../locales/zh-CN/toolMessages.json";
import zhTWToolMessages from "../locales/zh-TW/toolMessages.json";
import enShareCards from "../locales/en/shareCards.json";
import zhShareCards from "../locales/zh-CN/shareCards.json";
import zhTWShareCards from "../locales/zh-TW/shareCards.json";
import enShowcase from "../locales/en/showcase.json";
import zhShowcase from "../locales/zh-CN/showcase.json";
import zhTWShowcase from "../locales/zh-TW/showcase.json";
import enTraining from "../locales/en/training.json";
import zhTraining from "../locales/zh-CN/training.json";
import zhTWTraining from "../locales/zh-TW/training.json";
import enApiKeys from "../locales/en/apiKeys.json";
import zhApiKeys from "../locales/zh-CN/apiKeys.json";
import zhTWApiKeys from "../locales/zh-TW/apiKeys.json";
import enStorage from "../locales/en/storage.json";
import zhStorage from "../locales/zh-CN/storage.json";
import zhTWStorage from "../locales/zh-TW/storage.json";

export type Locale = "en" | "zh-CN" | "zh-TW";
export const LOCALE_STORAGE_KEY = "sparkdash-locale";

export function normalizeLocale(value: string | null | undefined): Locale | null {
  if (!value) return null;
  const tag = value.toLowerCase().replace(/_/g, "-");
  if (tag === "en" || tag.startsWith("en-")) return "en";
  if (tag === "zh-tw" || tag === "zh-hk" || tag === "zh-mo" || tag === "zh-hant" || tag.startsWith("zh-hant-")) return "zh-TW";
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
    en: { settings: enSettings, language: enLanguage, shell: enShell, overview: enOverview, spark: enSpark, activity: enActivity, statistics: enStatistics, devices: enDevices, hardware: enHardware, shareCards: enShareCards, toolMessages: enToolMessages, tooleval: enTooleval, benchmarks: enBenchmarks, showcase: enShowcase, apiKeys: enApiKeys, training: enTraining, storage: enStorage },
    "zh-CN": { settings: zhSettings, language: zhLanguage, shell: zhShell, overview: zhOverview, spark: zhSpark, activity: zhActivity, statistics: zhStatistics, devices: zhDevices, hardware: zhHardware, shareCards: zhShareCards, toolMessages: zhToolMessages, tooleval: zhTooleval, benchmarks: zhBenchmarks, showcase: zhShowcase, apiKeys: zhApiKeys, training: zhTraining, storage: zhStorage },
    "zh-TW": { settings: zhTWSettings, language: zhTWLanguage, shell: zhTWShell, overview: zhTWOverview, spark: zhTWSpark, activity: zhTWActivity, statistics: zhTWStatistics, devices: zhTWDevices, hardware: zhTWHardware, shareCards: zhTWShareCards, toolMessages: zhTWToolMessages, tooleval: zhTWTooleval, benchmarks: zhTWBenchmarks, showcase: zhTWShowcase, apiKeys: zhTWApiKeys, training: zhTWTraining, storage: zhTWStorage },
  },
  lng: detectLocale(),
  fallbackLng: "en",
  supportedLngs: ["en", "zh-CN", "zh-TW"],
  load: "currentOnly",
  defaultNS: "settings",
  ns: ["settings", "language", "shell", "overview", "spark", "activity", "statistics", "devices", "hardware", "shareCards", "toolMessages", "tooleval", "benchmarks", "showcase", "apiKeys", "training", "storage"],
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
