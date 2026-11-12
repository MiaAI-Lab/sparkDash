import { useEffect } from "react";

/**
 * Links into the Settings dialog: "#settings" opens it, "#settings/<section>" opens it at a
 * section (e.g. "#settings/energy" for the electricity price). Any page can link there with a
 * plain <a href>; App opens the dialog when the hash changes and clears the hash on close, so
 * the same link works again.
 */
export function settingsHref(section?: string): string {
  return section ? `#settings/${section}` : "#settings";
}

/** The section a settings hash asks for (null: the top), or undefined when it is not one. */
export function parseSettingsHash(hash: string): string | null | undefined {
  const m = /^#settings(?:\/([a-z][a-z-]*))?$/.exec(hash);
  return m ? (m[1] ?? null) : undefined;
}

/** Call `open(section)` for a settings hash, on load and whenever the hash changes. */
export function useSettingsHash(open: (section: string | null) => void): void {
  useEffect(() => {
    const check = () => {
      const section = parseSettingsHash(window.location.hash);
      if (section !== undefined) open(section);
    };
    check();
    window.addEventListener("hashchange", check);
    return () => window.removeEventListener("hashchange", check);
  }, [open]);
}

/** Drop a settings hash from the address without adding a history entry. */
export function clearSettingsHash(): void {
  if (parseSettingsHash(window.location.hash) === undefined) return;
  window.history.replaceState(window.history.state, "", window.location.pathname + window.location.search);
}