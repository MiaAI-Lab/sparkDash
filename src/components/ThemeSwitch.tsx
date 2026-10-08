import { useState, useEffect } from "react";
import { SunIcon, SunDimIcon, MoonIcon, MoonStarIcon } from "./ui/icons";

type Theme = "white" | "light" | "dark" | "oled";

const THEME_CYCLE: Theme[] = ["white", "light", "dark", "oled"];

const STORAGE_KEY = "sparkdash-theme";

function getInitialTheme(): Theme {
  if (typeof window === "undefined") return "dark";
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if ((stored as Theme | null) && THEME_CYCLE.includes(stored as Theme)) return stored as Theme;
  } catch {
    /* storage blocked (private mode): use the default */
  }
  return "dark";
}

export function ThemeSwitch() {
  const [theme, setTheme] = useState<Theme>(() => getInitialTheme());

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      /* storage blocked: the theme still applies for this session */
    }
    // The switch can be mounted twice (sidebar and phone bar): tell the other copy.
    window.dispatchEvent(new CustomEvent("sparkdash:set-theme", { detail: theme }));
  }, [theme]);

  const toggle = () =>
    setTheme((t) => {
      const idx = THEME_CYCLE.indexOf(t);
      return THEME_CYCLE[(idx + 1) % THEME_CYCLE.length];
    });

  // The command palette asks for a theme change through a window event.
  useEffect(() => {
    const onCycle = () =>
      setTheme((t) => THEME_CYCLE[(THEME_CYCLE.indexOf(t) + 1) % THEME_CYCLE.length]);
    // The Settings theme picker announces an explicit choice the same way.
    const onSet = (e: Event) => {
      const next = (e as CustomEvent<Theme>).detail;
      if (THEME_CYCLE.includes(next)) setTheme(next);
    };
    // Another window (e.g. the Showcase) changed the theme: follow it.
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY && e.newValue && THEME_CYCLE.includes(e.newValue as Theme)) setTheme(e.newValue as Theme);
    };
    window.addEventListener("storage", onStorage);
    window.addEventListener("sparkdash:cycle-theme", onCycle);
    window.addEventListener("sparkdash:set-theme", onSet);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("sparkdash:cycle-theme", onCycle);
      window.removeEventListener("sparkdash:set-theme", onSet);
    };
  }, []);

  const Icon =
    theme === "white"
      ? SunIcon
      : theme === "light"
        ? SunDimIcon
        : theme === "dark"
          ? MoonIcon
          : MoonStarIcon;

  return (
    <button
      type="button"
      onClick={toggle}
      className="icon-circle"
      title={`Theme: ${theme}`}
      aria-label={`Switch theme (currently ${theme})`}
    >
      <Icon className="h-3.5 w-3.5" />
    </button>
  );
}
