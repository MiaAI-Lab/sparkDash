import { useEffect, useCallback, useRef, useState } from "react";
import { OVERVIEW_ID, FLEET_STORAGE_ID } from "../constants";

export type RouteMode = "app" | "showcase";

/** Map a pathname to an active tab id (Overview or a Spark), or null. */
function activeIdFromPath(pathname: string): string | null {
  if (pathname === "/storage") return FLEET_STORAGE_ID;
  const spark = pathname.match(/^\/spark\/([^/]+)/);
  return spark ? decodeURIComponent(spark[1]) : OVERVIEW_ID;
}


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

/**
 * useRoute — syncs the browser URL path with the active spark ID.
 *
 * URL scheme:
 *   /             → Overview
 *   /spark/:id    → Spark detail page
 *   /showcase/:id → full-screen showcase (handled separately via useAppRoute)
 *
 * Call `navigate(id)` to switch views — it updates both the URL and
 * the internal activeId state. Back/forward buttons work via popstate.
 */
export function useRoute(
  setActiveId: (id: string | null) => void
): (id: string | null) => void {
  // Read initial activeId from the URL on mount
  const initialised = useRef(false);

  useEffect(() => {
    if (initialised.current) return;
    initialised.current = true;

    const path = window.location.pathname;
    if (path.startsWith("/showcase/")) return;
    setActiveId(activeIdFromPath(path));
  }, [setActiveId]);

  // Sync back/forward navigation
  useEffect(() => {
    const handler = () => {
      const path = window.location.pathname;
      if (path.startsWith("/showcase/")) return;
      setActiveId(activeIdFromPath(path));
    };
    window.addEventListener("popstate", handler);
    return () => window.removeEventListener("popstate", handler);
  }, [setActiveId]);

  // Wrapped navigate function — updates URL + internal state
  const navigate = useCallback(
    (id: string | null) => {
      let url = "/";
      if (id === FLEET_STORAGE_ID) url = "/storage";
      else if (id && id !== OVERVIEW_ID) url = `/spark/${encodeURIComponent(id)}`;
      window.history.pushState(null, "", url);
      setActiveId(id);
    },
    [setActiveId]
  );

  return navigate;
}
