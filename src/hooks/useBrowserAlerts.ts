import { useCallback, useEffect, useRef, useState } from "react";
import type { FleetAlertRow } from "./useFleetAlerts";

/**
 * Browser-side signals for active alerts: a count in the tab title, a dot on
 * the favicon, and desktop notifications for newly firing alerts.
 *
 * Preferences are per browser (Notification permission is too), kept in
 * localStorage and both off by default. Every storage access is wrapped:
 * private windows and locked-down browsers throw on localStorage.
 */

const STORAGE_KEY = "sparkdashBrowserAlerts";
const CHANGE_EVENT = "sparkdash:browser-alerts";

export interface BrowserAlertPrefs {
  /** "(2) sparkDash" in the tab title and a red / amber dot on the favicon. */
  tabBadge: boolean;
  /** Desktop notification when an alert starts firing. */
  desktop: boolean;
}

export const DEFAULT_BROWSER_ALERT_PREFS: BrowserAlertPrefs = Object.freeze({ tabBadge: false, desktop: false });

export function readBrowserAlertPrefs(): BrowserAlertPrefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_BROWSER_ALERT_PREFS };
    const parsed = JSON.parse(raw);
    return { tabBadge: parsed?.tabBadge === true, desktop: parsed?.desktop === true };
  } catch {
    return { ...DEFAULT_BROWSER_ALERT_PREFS };
  }
}

export function writeBrowserAlertPrefs(prefs: BrowserAlertPrefs): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    /* not persisted; still applied for this page below */
  }
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: prefs }));
}

/** Current prefs, live across components (and other tabs, via `storage`). */
export function useBrowserAlertPrefs(): [BrowserAlertPrefs, (next: BrowserAlertPrefs) => void] {
  const [prefs, setPrefs] = useState(readBrowserAlertPrefs);
  useEffect(() => {
    const onChange = (e: Event) => {
      const detail = (e as CustomEvent<BrowserAlertPrefs>).detail;
      setPrefs(detail ? { ...detail } : readBrowserAlertPrefs());
    };
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY) setPrefs(readBrowserAlertPrefs());
    };
    window.addEventListener(CHANGE_EVENT, onChange);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(CHANGE_EVENT, onChange);
      window.removeEventListener("storage", onStorage);
    };
  }, []);
  const update = useCallback((next: BrowserAlertPrefs) => writeBrowserAlertPrefs(next), []);
  return [prefs, update];
}

/**
 * Whether this page can show desktop notifications. The Notification API only
 * works in a secure context — HTTPS or localhost — so a plain-HTTP LAN install
 * gets "insecure" and a note instead of a toggle that silently does nothing.
 */
export type NotificationSupport = "ok" | "insecure" | "unsupported";

export function notificationSupport(): NotificationSupport {
  if (typeof window === "undefined") return "unsupported";
  if (!window.isSecureContext) return "insecure";
  if (!("Notification" in window)) return "unsupported";
  return "ok";
}

// ─── Favicon ─────────────────────────────────────────────

export const BADGE_COLORS = Object.freeze({ critical: "#dc2626", warning: "#f59e0b" });
const FAVICON_SIZE = 64;

/** An SVG without width/height draws at 300×150 in some browsers: give it a size. */
function sizedSvgHref(href: string, size: number): string {
  const m = /^data:image\/svg\+xml(;base64)?,(.*)$/s.exec(href);
  if (!m) return href;
  try {
    const svg = m[1] ? atob(m[2]) : decodeURIComponent(m[2]);
    if (/<svg[^>]*\swidth=/.test(svg)) return href;
    const sized = svg.replace(/<svg\b/, `<svg width='${size}' height='${size}'`);
    return `data:image/svg+xml,${encodeURIComponent(sized)}`;
  } catch {
    return href;
  }
}

/** The favicon at `href` with a coloured dot in its top-right corner, as a PNG data URL. */
export async function drawBadgedFavicon(href: string, color: string, size = FAVICON_SIZE): Promise<string | null> {
  const img = new Image();
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error("favicon did not load"));
    img.src = sizedSvgHref(href, size);
  });
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0, size, size);
  const r = size * 0.22;
  const cx = size - r - size * 0.04;
  const cy = r + size * 0.04;
  // Dark ring first, so the dot reads on light and dark tab strips alike.
  ctx.beginPath();
  ctx.arc(cx, cy, r + size * 0.05, 0, Math.PI * 2);
  ctx.fillStyle = "#111111";
  ctx.fill();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  return canvas.toDataURL("image/png");
}

/** Strip a count we (or an earlier page state) put in front of the title. */
function baseTitleOf(title: string): string {
  return title.replace(/^\(\d+\)\s+/, "");
}

/**
 * Apply the tab badge and desktop notifications for `rows`. `ready` is false
 * until there is real data, so a page still connecting neither badges nor
 * notifies — and alerts already active when it becomes ready are not "new".
 * `source` changing (server alerts switched on or off) starts a new baseline:
 * the same problems under the other side's keys are not news either.
 */
export function useBrowserAlerts(rows: FleetAlertRow[], ready: boolean, source = "browser"): void {
  const [prefs] = useBrowserAlertPrefs();
  const count = ready ? rows.length : 0;
  const tone: keyof typeof BADGE_COLORS | null =
    count === 0 ? null : rows.some((r) => r.severity === "critical") ? "critical" : "warning";
  const badge = prefs.tabBadge && tone !== null;

  // ─── Title ────────────────────────────────────────────
  const baseTitle = useRef<string | null>(null);
  useEffect(() => {
    if (baseTitle.current == null) baseTitle.current = baseTitleOf(document.title);
    document.title = badge ? `(${count}) ${baseTitle.current}` : baseTitle.current;
  }, [badge, count]);

  // ─── Favicon ──────────────────────────────────────────
  const originalIcon = useRef<{ href: string | null; type: string | null } | null>(null);
  const drawGeneration = useRef(0);
  useEffect(() => {
    const link = document.querySelector<HTMLLinkElement>('link[rel~="icon"]');
    if (!link) return;
    if (originalIcon.current == null) {
      originalIcon.current = { href: link.getAttribute("href"), type: link.getAttribute("type") };
    }
    const original = originalIcon.current;
    const generation = ++drawGeneration.current;
    const restore = () => {
      if (original.href != null) link.setAttribute("href", original.href);
      if (original.type != null) link.setAttribute("type", original.type);
      else link.removeAttribute("type");
    };
    if (!badge || !tone || !original.href) {
      restore();
      return;
    }
    drawBadgedFavicon(original.href, BADGE_COLORS[tone])
      .then((url) => {
        // A newer state (or a cleared one) won while this was drawing.
        if (!url || generation !== drawGeneration.current) return;
        link.setAttribute("type", "image/png");
        link.setAttribute("href", url);
      })
      .catch(() => {
        /* keep the plain icon; the title still carries the count */
      });
  }, [badge, tone]);

  // Put the page back as it was when the app unmounts.
  useEffect(
    () => () => {
      drawGeneration.current += 1;
      if (baseTitle.current != null) document.title = baseTitle.current;
      const link = document.querySelector<HTMLLinkElement>('link[rel~="icon"]');
      const original = originalIcon.current;
      if (link && original?.href != null) {
        link.setAttribute("href", original.href);
        if (original.type != null) link.setAttribute("type", original.type);
      }
    },
    []
  );

  // ─── Desktop notifications ───────────────────────────
  const known = useRef<{ source: string; keys: Set<string> } | null>(null);
  useEffect(() => {
    if (!ready) return;
    const previous = known.current?.source === source ? known.current.keys : null;
    known.current = { source, keys: new Set(rows.map((r) => r.key)) };
    // The first ready state is the baseline: what is already wrong is not news.
    if (previous === null || !prefs.desktop) return;
    if (notificationSupport() !== "ok" || Notification.permission !== "granted") return;
    for (const row of rows) {
      if (previous.has(row.key)) continue;
      try {
        const n = new Notification(`${row.severity === "critical" ? "Critical" : "Warning"} · ${row.unitName}`, {
          body: row.label,
          tag: row.key,
        });
        n.onclick = () => {
          window.focus();
          n.close();
        };
      } catch {
        /* e.g. Android Chrome requires a service worker for notifications */
      }
    }
  }, [rows, ready, source, prefs.desktop]);
}
