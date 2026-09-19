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
import { canCopyImages, copyCardImage, copyTextOnly, renderCardObjectUrl } from "./shareImage";

type CopyState = "idle" | "working" | "text" | "image" | "downloaded" | "shown";

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
    case "shown":
      return "Card shown";
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
  /** Secure context? Without it the card can only be downloaded. */
  const imageClipboard = shareImage && canCopyImages();
  const [menuOpen, setMenuOpen] = useState(false);
  /** Fixed-position coordinates, measured when the menu opens. */
  const [anchor, setAnchor] = useState<{ top: number; right: number } | null>(null);
  /** Blob URL of the card when it is on screen (insecure contexts only). */
  const [preview, setPreview] = useState<string | null>(null);
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

  // The preview owns a blob URL; release it when it goes away.
  useEffect(() => () => {
    if (preview) URL.revokeObjectURL(preview);
  }, [preview]);

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

  // Close the menu on an outside click, and take Escape before the dialog does:
  // Escape closes the card preview first, then the menu, and never the dialog.
  useEffect(() => {
    if (!menuOpen && !preview) return;
    const onPointerDown = (e: MouseEvent) => {
      if (!menuOpen) return;
      const target = e.target as Node;
      if (groupRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setMenuOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Capture phase: the dialog also listens for Escape and would close.
      e.stopPropagation();
      if (preview) closePreview();
      else setMenuOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [menuOpen, preview]);

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
    // No clipboard image support: skip an attempt the browser will reject and
    // go straight to the download, so the button does what its label says.
    const outcome = await copyCardImage(
      card,
      shareCardFileName(card, kind),
      imageClipboard ? {} : { writeClipboard: null }
    );
    if (outcome === "copied") flash("image");
    else if (outcome === "downloaded") flash("downloaded");
    else {
      setState("idle");
      onError("Could not copy the image to the clipboard");
    }
  };

  /**
   * Show the card as an image, in the page. On a page with no image clipboard
   * this is the only route to a real image on the pasteboard: the browser's own
   * right-click → Copy Image and drag-out both work from what is on screen.
   * A popup would be the other option, but popups get blocked (and cannot be
   * verified from here), and an in-page image is draggable anyway.
   */
  const showImage = async () => {
    setMenuOpen(false);
    if (state === "working") return;
    setState("working");
    const url = await renderCardObjectUrl(buildCard());
    if (!url) {
      setState("idle");
      onError("Could not render the card image");
      return;
    }
    setPreview(url);
    flash("shown");
  };

  const closePreview = () => {
    setPreview((url) => {
      if (url) URL.revokeObjectURL(url);
      return null;
    });
  };

  const downloadPreview = () => {
    const link = document.createElement("a");
    link.href = preview ?? "";
    link.download = shareCardFileName(buildCard(), kind);
    document.body.appendChild(link);
    link.click();
    link.remove();
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
        title={
          imageClipboard
            ? "Copy as text or as an image"
            : "Copy as text, or show or download the image"
        }
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
            {imageClipboard ? (
              <button
                type="button"
                role="menuitem"
                className="block w-full rounded px-2 py-1.5 text-left text-[11px] text-muted transition-colors hover:bg-surface-hover hover:text-text"
                onClick={() => void copyImage()}
              >
                Copy as image
              </button>
            ) : (
              <>
                <button
                  type="button"
                  role="menuitem"
                  className="block w-full rounded px-2 py-1.5 text-left text-[11px] text-muted transition-colors hover:bg-surface-hover hover:text-text"
                  onClick={() => void showImage()}
                  title="This page is served over http on a LAN address, where a page cannot write images to the clipboard. The card is shown as an image instead — right-click → Copy Image, or drag it into your post."
                >
                  Show card
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="block w-full rounded px-2 py-1.5 text-left text-[11px] text-muted transition-colors hover:bg-surface-hover hover:text-text"
                  onClick={() => void copyImage()}
                >
                  Download PNG
                </button>
              </>
            )}
          </span>,
          document.body
        )}
      {preview &&
        createPortal(
          <span
            role="dialog"
            aria-label="Benchmark share card"
            className="fixed inset-0 z-[10000] flex flex-col items-center justify-center gap-3 bg-black/75 p-5"
            onMouseDown={(e) => {
              if (e.target === e.currentTarget) closePreview();
            }}
          >
            {/* eslint-disable-next-line jsx-a11y/alt-text -- alt text is on the img below */}
            <img
              src={preview}
              alt="Benchmark result card — right-click to copy it"
              className="max-h-[68vh] max-w-full rounded-lg border border-border shadow-card"
            />
            <span className="flex max-w-lg flex-col items-center gap-2">
              <span className="text-center text-[11px] leading-snug text-white/85">
                Right-click → <strong>Copy Image</strong>, or drag the card straight into your post.
                Browsers only let a page write images to the clipboard over HTTPS or localhost, which
                this page is not — so the image is here for your browser to copy.
              </span>
              <span className="flex gap-2">
                <button
                  type="button"
                  className="bench-btn bench-btn--ghost"
                  onClick={downloadPreview}
                >
                  Download PNG
                </button>
                <button type="button" className="bench-btn bench-btn--primary" onClick={closePreview}>
                  Close
                </button>
              </span>
            </span>
          </span>,
          document.body
        )}
    </span>
  );
}
