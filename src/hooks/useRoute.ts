import { withPageTransition } from "./pageTransition";
import { useEffect, useCallback, useMemo, useState } from "react";
import { idToPath, pathToId } from "../constants";

export type RouteMode = "app" | "showcase";

export interface AppRoute {
  mode: RouteMode;
  /** Spark id for showcase mode */
  showcaseSparkId: string | null;
}

function parsePath(pathname: string): AppRoute {
  const showcase = pathname.match(/^\/showcase\/([^/]+)/);
  if (showcase) {
    return {
      mode: "showcase",
      showcaseSparkId: decodeURIComponent(showcase[1]),
    };
  }
  return { mode: "app", showcaseSparkId: null };
}

/**
 * Parse the current URL for showcase vs normal app shell.
 * Call once at App root so showcase skips the dashboard chrome.
 */
export function useAppRoute(): AppRoute {
  const [route, setRoute] = useState(() => parsePath(window.location.pathname));

  useEffect(() => {
    const handler = () => setRoute(parsePath(window.location.pathname));
    window.addEventListener("popstate", handler);
    return () => window.removeEventListener("popstate", handler);
  }, []);

  return route;
}

export interface RouteActions {
  /** Switch view: pushes a history entry, runs the page transition and scrolls to the top. */
  navigate: (id: string | null) => void;
  /** Switch view without adding a history entry (correcting a URL that no longer fits). */
  replace: (id: string | null) => void;
}

/**
 * useRoute — syncs the browser URL path with the active spark ID.
 *
 * URL scheme:
 *   /                      → Overview
 *   /tokens /energy /activity → dedicated fleet pages
 *   /spark/:id             → Spark detail page
 *   /bench/:type           → benchmark page
 *   /showcase/:id          → full-screen showcase (handled separately via useAppRoute)
 *
 * The initial id comes from `initialActiveId()` in constants (pass it to the state's initialiser).
 * `navigate(id)` updates the URL and the active id; Back/forward work via popstate.
 */
export function useRoute(setActiveId: (id: string | null) => void): RouteActions {
  // Sync back/forward navigation (the browser restores the scroll position itself)
  useEffect(() => {
    const handler = () => {
      const id = pathToId(window.location.pathname);
      if (id !== null) withPageTransition(() => setActiveId(id));
    };
    window.addEventListener("popstate", handler);
    return () => window.removeEventListener("popstate", handler);
  }, [setActiveId]);

  const navigate = useCallback(
    (id: string | null) => {
      window.history.pushState(null, "", idToPath(id));
      withPageTransition(() => setActiveId(id), { scrollTop: true });
    },
    [setActiveId]
  );

  const replace = useCallback(
    (id: string | null) => {
      window.history.replaceState(null, "", idToPath(id));
      setActiveId(id);
    },
    [setActiveId]
  );

  return useMemo(() => ({ navigate, replace }), [navigate, replace]);
}
