/**
 * The benchmark dialogs' copy control.
 *
 * Off (the default) it is exactly the old text button. With the share-image
 * setting on it becomes a split button: the label copies the text summary, and
 * a caret on its right offers the format — text or image — on hover or click.
 * Text stays the default because pasting the numbers into an editor or a chat is
 * the common case; the card is what you want for a timeline.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDownIcon } from "../ui/icons";
import { shareCardFileName, type ShareCardModel } from "./benchShareCard";
import { copyCardImage, copyTextOnly } from "./shareImage";

type CopyState = "idle" | "working" | "text" | "image" | "downloaded";

interface BenchCopyButtonProps {
  /** Plain-text summary — what the button itself copies. */
  text: string;
  /** Builds the share card lazily; only called when an image is requested. */
  buildCard: () => ShareCardModel;
  /** Which benchmark the card came from — used for the download name. */
  kind: "decode" | "prefill";
  /** Settings → Benchmark share image: adds the format menu to the button. */
  shareImage: boolean;
  onError: (message: string) => void;
}

function stateLabel(state: CopyState, shareImage: boolean): string {
  switch (state) {
    case "working":
      return "Copying…";
    case "image":
      return "Image copied!";
    case "downloaded":
      return "PNG saved";
    case "text":
      // Off, this is the copy button as it always was.
      return shareImage ? "Copied text!" : "Copied!";
    default:
      return "Copy results";
  }
}

/** Delay before a hover-opened menu closes, so the pointer can cross the gap. */
const CLOSE_DELAY_MS = 150;
/** Distance between the button and the menu, and the smallest edge margin. */
const MENU_GAP = 6;
const EDGE_MARGIN = 8;

export function BenchCopyButton({
  text,
  buildCard,
  kind,
  shareImage,
  onError,
}: BenchCopyButtonProps) {
  const [state, setState] = useState<CopyState>("idle");
  const [menuOpen, setMenuOpen] = useState(false);
  /** Fixed-position coordinates, measured when the menu opens. */
  const [anchor, setAnchor] = useState<{ top: number; right: number } | null>(null);
  const resetRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const groupRef = useRef<HTMLSpanElement | null>(null);
  const menuRef = useRef<HTMLSpanElement | null>(null);

  useEffect(
    () => () => {
      if (resetRef.current != null) clearTimeout(resetRef.current);
      if (closeRef.current != null) clearTimeout(closeRef.current);
    },
    []
  );

  /**
   * Anchor the menu under the button. The menu is portalled out of the dialog
   * because the sheet clips its overflow (`overflow: hidden`), so a menu hung
   * inside the footer renders nowhere; `position: fixed` keeps it clear of that
   * box. It flips above only when the viewport has no room below — a phone
   * shows this dialog as a bottom sheet, with the footer against the edge.
   */
  const placeMenu = useCallback(() => {
    const group = groupRef.current;
    if (!group) return;
    const rect = group.getBoundingClientRect();
    const menuHeight = menuRef.current?.offsetHeight ?? 0;
    const below = rect.bottom + MENU_GAP;
    const overflowsBelow =
      menuHeight > 0 && below + menuHeight > window.innerHeight - EDGE_MARGIN;
    setAnchor({
      top: overflowsBelow
        ? Math.max(EDGE_MARGIN, rect.top - MENU_GAP - menuHeight)
        : below,
      right: Math.max(EDGE_MARGIN, window.innerWidth - rect.right),
    });
  }, []);

  // Measure after the menu is in the DOM so the flip decision uses its real
  // height, and re-place it while it is open.
  useLayoutEffect(() => {
    if (!menuOpen) {
      setAnchor(null);
      return;
    }
    placeMenu();
    const onReflow = () => placeMenu();
    window.addEventListener("resize", onReflow);
    window.addEventListener("scroll", onReflow, true);
    return () => {
      window.removeEventListener("resize", onReflow);
      window.removeEventListener("scroll", onReflow, true);
    };
  }, [menuOpen, placeMenu]);

  // Close on an outside click, and on Escape before the dialog sees it.
  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (groupRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setMenuOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Capture phase: the dialog also listens for Escape and would close.
      e.stopPropagation();
      setMenuOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [menuOpen]);

  const flash = (next: CopyState) => {
    setState(next);
    if (resetRef.current != null) clearTimeout(resetRef.current);
    resetRef.current = setTimeout(() => setState("idle"), 1800);
  };

  const copyText = async () => {
    setMenuOpen(false);
    if (state === "working") return;
    try {
      await copyTextOnly(text);
      flash("text");
    } catch {
      onError("Could not copy results to clipboard");
    }
  };

  const copyImage = async () => {
    setMenuOpen(false);
    if (state === "working") return;
    setState("working");
    const card = buildCard();
    const outcome = await copyCardImage(card, shareCardFileName(card, kind));
    if (outcome === "copied") flash("image");
    else if (outcome === "downloaded") flash("downloaded");
    else {
      setState("idle");
      onError("Could not copy the image to the clipboard");
    }
  };

  const openMenu = () => {
    if (closeRef.current != null) clearTimeout(closeRef.current);
    setMenuOpen(true);
  };
  const scheduleClose = () => {
    if (closeRef.current != null) clearTimeout(closeRef.current);
    closeRef.current = setTimeout(() => setMenuOpen(false), CLOSE_DELAY_MS);
  };
  const cancelClose = () => {
    if (closeRef.current != null) clearTimeout(closeRef.current);
  };

  if (!shareImage) {
    return (
      <button
        type="button"
        className="bench-btn bench-btn--ghost"
        onClick={() => void copyText()}
        disabled={state === "working"}
        title="Copy a plain-text summary to the clipboard"
      >
        {stateLabel(state, shareImage)}
      </button>
    );
  }

  return (
    <span
      ref={groupRef}
      className="bench-copy-group relative inline-flex items-stretch"
      // Only the caret opens the menu: hovering the label has to stay inert,
      // or it looks like the label copies the image.
      onMouseLeave={scheduleClose}
    >
      <button
        type="button"
        className="bench-btn bench-btn--ghost"
        onClick={() => void copyText()}
        disabled={state === "working"}
        title="Copy the results as plain text — the caret on the right copies the share-card image instead"
      >
        {stateLabel(state, shareImage)}
      </button>
      <button
        type="button"
        className="bench-btn bench-btn--ghost bench-copy-caret -ml-px px-1.5"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        aria-label="Copy format"
        title="Copy as text or as an image"
        disabled={state === "working"}
        onMouseEnter={openMenu}
        // Open only: hovering already opens it, so a click that toggled shut
        // would close the menu the pointer just opened.
        onClick={openMenu}
      >
        <ChevronDownIcon className="h-3 w-3" />
      </button>
      {menuOpen &&
        createPortal(
          <span
            ref={menuRef}
            role="menu"
            aria-label="Copy format"
            onMouseEnter={cancelClose}
            onMouseLeave={scheduleClose}
            style={{
              position: "fixed",
              top: anchor?.top ?? 0,
              right: anchor?.right ?? EDGE_MARGIN,
              // Above the dialog overlay (z-index 9999) it is portalled over.
              zIndex: 10000,
              // Hidden for the measuring pass so it never flashes in place.
              visibility: anchor ? "visible" : "hidden",
            }}
            className="min-w-[9.5rem] rounded-md border border-border bg-surface-elevated p-1 shadow-card"
          >
            <button
              type="button"
              role="menuitem"
              className="block w-full rounded px-2 py-1.5 text-left text-[11px] text-muted transition-colors hover:bg-surface-hover hover:text-text"
              onClick={() => void copyText()}
            >
              Copy as text
            </button>
            <button
              type="button"
              role="menuitem"
              className="block w-full rounded px-2 py-1.5 text-left text-[11px] text-muted transition-colors hover:bg-surface-hover hover:text-text"
              onClick={() => void copyImage()}
            >
              Copy as image
            </button>
          </span>,
          document.body
        )}
    </span>
  );
}
