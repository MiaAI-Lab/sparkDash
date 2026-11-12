import { settingsHref } from "../../hooks/settingsLink";

/** A hint that opens Settings at a section, e.g. the electricity price ("energy"). */
export function SettingsLink({ section, children }: { section?: string; children: React.ReactNode }) {
  return (
    <a className="settings-link" href={settingsHref(section)}>
      {children}
    </a>
  );
}