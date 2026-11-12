/**
 * The Settings dialog's tabs, in order. A "#settings/<tab>" link opens that tab
 * (see hooks/settingsLink); the dialog keeps the open tab in the address.
 */
export const SETTINGS_TABS = ["general", "overview", "sparks", "energy", "integrations", "security"] as const;
export type SettingsTab = (typeof SETTINGS_TABS)[number];

/** The tab a link's section opens; anything else opens General. */
export function tabForSection(section: string | null | undefined): SettingsTab {
  return SETTINGS_TABS.find((tab) => tab === section) ?? "general";
}

/** The tab an arrow, Home or End key moves to from `current`, or null for other keys. */
export function tabAfterKey(current: SettingsTab, key: string): SettingsTab | null {
  const i = SETTINGS_TABS.indexOf(current);
  const n = SETTINGS_TABS.length;
  if (key === "ArrowRight") return SETTINGS_TABS[(i + 1) % n];
  if (key === "ArrowLeft") return SETTINGS_TABS[(i - 1 + n) % n];
  if (key === "Home") return SETTINGS_TABS[0];
  if (key === "End") return SETTINGS_TABS[n - 1];
  return null;
}