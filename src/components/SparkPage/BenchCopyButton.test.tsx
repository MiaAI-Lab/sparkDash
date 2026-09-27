/**
 * The dialogs' copy control: off it is the plain text button, on it is a split
 * button whose label copies text and whose caret offers the image.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { render } from "../../testing/render";
import type { ShareCardModel } from "./benchShareCard";
import { BenchCopyButton } from "./BenchCopyButton";
import { canCopyImages, copyCardImage, copyTextOnly, renderCardObjectUrl } from "./shareImage";

vi.mock("./shareImage", () => ({
  copyTextOnly: vi.fn(async () => {}),
  copyCardImage: vi.fn(async () => "copied"),
  renderCardObjectUrl: vi.fn(async () => "blob:card"),
  // Default: a secure context, so the menu offers the clipboard.
  canCopyImages: vi.fn(() => true),
}));

const card: ShareCardModel = {
  brand: "sparkDash",
  host: "spark-38bd",
  title: "Decode benchmark",
  subtitle: "Port 8888",
  status: { label: "COMPLETED", tone: "ok" },
  meta: "Prose · 400 tok",
  columns: { load: "Load", primary: "Aggregate", secondary: "Stream" },
  rows: [],
  legend: "Aggregate — …",
  footer: "github.com/MiaAI-Lab/sparkDash",
  generatedAt: Date.UTC(2026, 8, 17),
};

function mount(shareImage: boolean, onError = vi.fn()) {
  const { container } = render(
    <BenchCopyButton
      text="summary text"
      buildCard={() => card}
      kind="decode"
      shareImage={shareImage}
      onError={onError}
    />
  );
  return { root: container as HTMLElement, onError };
}

const buttons = (root: HTMLElement) => Array.from(root.querySelectorAll("button"));
/** The menu is portalled out of the dialog (the sheet clips its overflow). */
const menuEl = () => document.querySelector('[role="menu"]') as HTMLElement | null;
const menuItems = () =>
  Array.from(document.querySelectorAll('[role="menuitem"]')).map((i) => (i.textContent || "").trim());
const byText = (root: HTMLElement, text: string) =>
  buttons(root).find((b) => (b.textContent || "").trim() === text);
const click = (el: Element) => act(() => (el as HTMLButtonElement).click());

afterEach(() => {
  vi.mocked(copyTextOnly).mockClear();
  vi.mocked(copyCardImage).mockClear();
  vi.mocked(canCopyImages).mockReturnValue(true);
  vi.mocked(renderCardObjectUrl).mockResolvedValue("blob:card");
});

describe("with the share image off", () => {
  it("is exactly the old text button", () => {
    const { root } = mount(false);
    const labels = buttons(root).map((b) => (b.textContent || "").trim());
    expect(labels).toEqual(["Copy results"]);
    expect(root.querySelector('[aria-haspopup="menu"]')).toBeNull();
  });

  it("copies the text and reports it the way it always did", async () => {
    const { root } = mount(false);
    await act(async () => byText(root, "Copy results")!.click());
    expect(copyTextOnly).toHaveBeenCalledWith("summary text");
    expect(copyCardImage).not.toHaveBeenCalled();
    expect((byText(root, "Copied!")?.textContent || "").trim()).toBe("Copied!");
  });
});

describe("with the share image on", () => {
  it("defaults the label to text and hides the menu until asked", () => {
    const { root } = mount(true);
    expect(byText(root, "Copy results")).toBeTruthy();
    expect(menuEl()).toBeNull();
    expect(root.querySelector('[aria-haspopup="menu"]')?.getAttribute("aria-expanded")).toBe("false");
  });

  it("copies text from the label and says which format went out", async () => {
    const { root } = mount(true);
    await act(async () => byText(root, "Copy results")!.click());
    expect(copyTextOnly).toHaveBeenCalledWith("summary text");
    expect(byText(root, "Copied text!")).toBeTruthy();
  });

  it("opens the format menu from the caret and copies the image", async () => {
    const { root } = mount(true);
    const caret = root.querySelector('[aria-haspopup="menu"]')!;
    click(caret);
    expect(menuEl()).toBeTruthy();
    expect(caret.getAttribute("aria-expanded")).toBe("true");
    expect(menuItems()).toEqual(["Copy as text", "Copy as image"]);

    const imageItem = Array.from(document.querySelectorAll('[role="menuitem"]')).find(
      (el) => (el.textContent || "").trim() === "Copy as image"
    )!;
    await act(async () => (imageItem as HTMLButtonElement).click());
    expect(copyCardImage).toHaveBeenCalledTimes(1);
    expect(copyTextOnly).not.toHaveBeenCalled();
    expect(byText(root, "Image copied!")).toBeTruthy();
    expect(menuEl()).toBeNull();
  });

  it("hangs the menu below the button, portalled clear of the clipping sheet", () => {
    const { root } = mount(true);
    click(root.querySelector('[aria-haspopup="menu"]')!);
    const menu = menuEl()!;
    // .bench-sheet sets overflow:hidden, so the menu renders on document.body
    // with fixed coordinates — inside the footer it would be invisible.
    expect(menu.parentElement).toBe(document.body);
    expect(root.contains(menu)).toBe(false);
    expect(menu.style.position).toBe("fixed");
    // jsdom reports a zero-height button, so this is the plain "below" anchor.
    expect(Number.parseInt(menu.style.top, 10)).toBeGreaterThan(0);
  });

  it("opens on hovering the caret but stays inert over the label", () => {
    const { root } = mount(true);
    const [label, caret] = buttons(root);
    // React fires mouseenter from a delegated mouseover whose relatedTarget is
    // outside the element.
    const hover = (el: Element) =>
      act(() => {
        el.dispatchEvent(
          new MouseEvent("mouseover", { bubbles: true, relatedTarget: document.body })
        );
      });

    hover(label);
    expect(menuEl()).toBeNull();

    hover(caret);
    expect(menuEl()).toBeTruthy();
  });

  it("shows the card in the page when the browser has no image clipboard", async () => {
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    vi.mocked(canCopyImages).mockReturnValue(false);
    const { root } = mount(true);
    click(root.querySelector('[aria-haspopup="menu"]')!);
    // Plain http on a LAN IP is not a secure context, so no page can write an
    // image to the clipboard there; the card goes on screen instead, where the
    // browser's own right-click Copy Image and drag-out work.
    expect(menuItems()).toEqual(["Copy as text", "Show card", "Download PNG"]);

    const item = Array.from(document.querySelectorAll('[role="menuitem"]')).find(
      (el) => (el.textContent || "").trim() === "Show card"
    )!;
    await act(async () => (item as HTMLButtonElement).click());
    expect(renderCardObjectUrl).toHaveBeenCalledTimes(1);
    expect(copyCardImage).not.toHaveBeenCalled();
    expect(byText(root, "Card shown")).toBeTruthy();

    const img = document.querySelector('[role="dialog"] img') as HTMLImageElement | null;
    expect(img?.getAttribute("src")).toBe("blob:card");
    expect(document.body.textContent).toContain("Right-click");

    // Close puts the blob URL out of its misery.
    const close = Array.from(document.querySelectorAll('[role="dialog"] button')).find(
      (b) => (b.textContent || "").trim() === "Close"
    )!;
    await act(async () => (close as HTMLButtonElement).click());
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(revoke).toHaveBeenCalledWith("blob:card");
    revoke.mockRestore();
  });

  it("still lets the card be downloaded where it cannot be copied", async () => {
    vi.mocked(canCopyImages).mockReturnValue(false);
    vi.mocked(copyCardImage).mockResolvedValueOnce("downloaded");
    const { root } = mount(true);
    click(root.querySelector('[aria-haspopup="menu"]')!);
    const item = Array.from(document.querySelectorAll('[role="menuitem"]')).find(
      (el) => (el.textContent || "").trim() === "Download PNG"
    )!;
    await act(async () => (item as HTMLButtonElement).click());
    expect(copyCardImage).toHaveBeenCalledWith(expect.anything(), expect.any(String), {
      writeClipboard: null,
    });
    expect(byText(root, "PNG saved")).toBeTruthy();
  });

  it("copies text from the menu as well", async () => {
    const { root } = mount(true);
    click(root.querySelector('[aria-haspopup="menu"]')!);
    const textItem = Array.from(document.querySelectorAll('[role="menuitem"]')).find(
      (el) => (el.textContent || "").trim() === "Copy as text"
    )!;
    await act(async () => (textItem as HTMLButtonElement).click());
    expect(copyTextOnly).toHaveBeenCalledWith("summary text");
  });

  it("reports a download instead of a copy when the clipboard refuses the image", async () => {
    vi.mocked(copyCardImage).mockResolvedValueOnce("downloaded");
    const { root } = mount(true);
    click(root.querySelector('[aria-haspopup="menu"]')!);
    const imageItem = Array.from(document.querySelectorAll('[role="menuitem"]')).find(
      (el) => (el.textContent || "").trim() === "Copy as image"
    )!;
    await act(async () => (imageItem as HTMLButtonElement).click());
    expect(byText(root, "PNG saved")).toBeTruthy();
  });

  it("surfaces a text-copy failure instead of claiming success", async () => {
    vi.mocked(copyTextOnly).mockRejectedValueOnce(new Error("denied"));
    const { root, onError } = mount(true);
    await act(async () => byText(root, "Copy results")!.click());
    expect(onError).toHaveBeenCalledWith("Could not copy results to clipboard");
    expect(byText(root, "Copy results")).toBeTruthy();
  });
});
