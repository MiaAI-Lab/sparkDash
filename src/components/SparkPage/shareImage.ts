/**
 * Clipboard glue for the benchmark dialogs.
 *
 * Two representations, chosen explicitly: the copy button writes the text
 * summary, and its format menu writes the share card. Pasting into an editor is
 * the common case, so text is the button's default; the card is one click away
 * for a timeline.
 *
 * Every dependency is injectable so the paths below are unit-testable without a
 * real canvas or clipboard: the PNG encode, the clipboard write, and the
 * download that keeps the image usable when the clipboard refuses.
 */
import {
  SHARE_CARD_SCALE,
  SHARE_CARD_WIDTH,
  paintShareCard,
  shareCardHeight,
  type ShareCardModel,
} from "./benchShareCard";

export interface ShareImageDeps {
  /** Canvas factory — tests pass a fake with a recording 2D context. */
  createCanvas?: () => HTMLCanvasElement;
  /** Clipboard writer for the PNG; `null` disables it. */
  writeClipboard?: ((blob: Blob) => Promise<void>) | null;
  /** Clipboard writer for the text; `null` disables it. */
  writeText?: ((text: string) => Promise<void>) | null;
  download?: (blob: Blob, fileName: string) => void;
}

function defaultCreateCanvas(): HTMLCanvasElement {
  return document.createElement("canvas");
}

async function defaultWriteClipboard(blob: Blob): Promise<void> {
  if (typeof ClipboardItem === "undefined" || !navigator.clipboard?.write) {
    throw new Error("clipboard image write unsupported");
  }
  await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
}

function defaultDownload(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Give the browser time to start the download before the URL dies.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/**
 * Copy the text summary. Falls back to the textarea trick where the async
 * clipboard is missing or blocked — the pre-share-card behaviour, unchanged.
 */
export async function copyTextOnly(text: string, deps: ShareImageDeps = {}): Promise<void> {
  const write = deps.writeText === undefined ? navigator.clipboard?.writeText?.bind(navigator.clipboard) : deps.writeText;
  if (write) {
    await write(text);
    return;
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  document.execCommand("copy");
  document.body.removeChild(ta);
}

/** Paint the card at 2× and encode it, or `null` when the browser cannot. */
export function renderShareCardPng(
  model: ShareCardModel,
  deps: ShareImageDeps = {}
): Promise<Blob | null> {
  try {
    const canvas = (deps.createCanvas ?? defaultCreateCanvas)();
    canvas.width = SHARE_CARD_WIDTH * SHARE_CARD_SCALE;
    canvas.height = shareCardHeight(model) * SHARE_CARD_SCALE;
    const ctx = canvas.getContext("2d");
    if (!ctx) return Promise.resolve(null);
    ctx.scale(SHARE_CARD_SCALE, SHARE_CARD_SCALE);
    paintShareCard(ctx, model);
    return new Promise((resolve) => {
      canvas.toBlob((blob) => resolve(blob ?? null), "image/png");
    });
  } catch {
    return Promise.resolve(null);
  }
}

/**
 * Whether this page can put an *image* on the clipboard at all.
 *
 * `navigator.clipboard.write` exists only in a secure context — HTTPS or
 * localhost. The default Docker install is reached over plain http on a LAN IP,
 * where the property is missing entirely, so the card can only be downloaded
 * there. Text still copies in that case, because it falls back to the legacy
 * `execCommand("copy")` path, which has no image equivalent.
 */
export function canCopyImages(): boolean {
  return (
    typeof window !== "undefined" &&
    window.isSecureContext === true &&
    typeof ClipboardItem !== "undefined" &&
    typeof navigator.clipboard?.write === "function"
  );
}

export type CardCopyOutcome = "copied" | "downloaded" | "failed";

/**
 * Copy the share card, downloading it when the clipboard refuses (insecure
 * context, denied permission, no image support). Resolves with what happened;
 * the caller only has to report it.
 */
export async function copyCardImage(
  model: ShareCardModel,
  fileName: string,
  deps: ShareImageDeps = {}
): Promise<CardCopyOutcome> {
  const png = await renderShareCardPng(model, deps);
  if (!png) return "failed";

  if (deps.writeClipboard !== null) {
    try {
      await (deps.writeClipboard ?? defaultWriteClipboard)(png);
      return "copied";
    } catch {
      /* fall through to the download — the user still gets the image */
    }
  }

  (deps.download ?? defaultDownload)(png, fileName);
  return "downloaded";
}

/**
 * Render the card to a blob URL the caller can show as an image.
 *
 * This is the way out for a page that cannot write an image to the clipboard at
 * all — plain http on a LAN IP, where `navigator.clipboard.write` does not exist
 * and the legacy `execCommand("copy")` puts markup, not a bitmap, on the
 * pasteboard (verified against the OS clipboard: HTML arrives, no PNG). Showing
 * the PNG lets the *browser's* own affordances do the work: right-click → Copy
 * Image, drag it into a post, or save it.
 *
 * The caller owns the URL and should revoke it when the image is gone.
 */
export async function renderCardObjectUrl(
  model: ShareCardModel,
  deps: ShareImageDeps = {}
): Promise<string | null> {
  const png = await renderShareCardPng(model, deps);
  if (!png) return null;
  return URL.createObjectURL(png);
}
