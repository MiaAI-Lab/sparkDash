import { useEffect, useState } from "react";

/**
 * Keep a modal mounted through open/close CSS transitions.
 * - open → mount, then next frame add `visible` (enter)
 * - close → clear `visible`, unmount after `durationMs` (exit)
 *
 * When `escapeOnClose` is set, Escape key calls `onClose`.
 * When `lockScroll` is set (default true), body overflow is hidden while mounted.
 */
export function useModalPresence(
  open: boolean,
  durationMs = 240,
  opts?: { escapeOnClose?: () => void; lockScroll?: boolean }
) {
  const [mounted, setMounted] = useState(open);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (open) {
      setMounted(true);
      let raf2 = 0;
      const raf1 = requestAnimationFrame(() => {
        raf2 = requestAnimationFrame(() => setVisible(true));
      });
      return () => {
        cancelAnimationFrame(raf1);
        cancelAnimationFrame(raf2);
      };
    }

    setVisible(false);
    const t = window.setTimeout(() => setMounted(false), durationMs);
    return () => window.clearTimeout(t);
  }, [open, durationMs]);

  // Escape key → onClose (only while mounted/open)
  const escapeOnClose = opts?.escapeOnClose;
  useEffect(() => {
    if (!escapeOnClose || !mounted) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") escapeOnClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [escapeOnClose, mounted]);

  // Lock body scroll while mounted
  const lockScroll = opts?.lockScroll ?? true;
  useEffect(() => {
    if (!mounted || !lockScroll) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [mounted, lockScroll]);

  return { mounted, visible };
}
