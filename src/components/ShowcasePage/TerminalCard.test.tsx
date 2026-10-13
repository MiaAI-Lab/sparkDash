import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanupRenders, render } from "../../testing/render";
import { TerminalCard, useSmoothText } from "./TerminalCard";

const originalMedia = Object.getOwnPropertyDescriptor(window, "matchMedia");
function motion(initial: boolean) {
  let reduced = initial;
  const listeners = new Set<() => void>();
  const media = {
    get matches() { return reduced; },
    media: "(prefers-reduced-motion: reduce)",
    addEventListener: (_: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
  } as unknown as MediaQueryList;
  Object.defineProperty(window, "matchMedia", { configurable: true, value: () => media });
  return (value: boolean) => act(() => { reduced = value; listeners.forEach((fn) => fn()); });
}
function card(content: string, reasoning = "", status = "streaming") {
  return <TerminalCard label="Test" status={status} liveTokPerSec={12} peakTokPerSec={12}
    tokenCount={12} content={content} reasoning={reasoning} error={null} />;
}
function Smooth({ text }: { text: string }) {
  return <pre>{useSmoothText(text, true)}</pre>;
}
afterEach(() => {
  cleanupRenders();
  vi.unstubAllGlobals();
  if (originalMedia) Object.defineProperty(window, "matchMedia", originalMedia);
  else Reflect.deleteProperty(window, "matchMedia");
});
describe("Showcase text with reduced motion", () => {
  it("displays each answer update after an initially empty terminal", () => {
    motion(true);
    const view = render(card("", "", "pending"));
    act(() => view.root.render(card("First tokens")));
    expect(view.container.querySelector(".showcase-term__answer")?.textContent).toBe("First tokens");
    act(() => view.root.render(card("First tokens and more")));
    expect(view.container.querySelector(".showcase-term__answer")?.textContent).toBe("First tokens and more");
  });
  it("displays reasoning updates and saved history without animation", () => {
    motion(true);
    const view = render(card("", "", "pending"));
    act(() => view.root.render(card("", "Visible reasoning")));
    expect(view.container.querySelector(".showcase-term__reasoning-text")?.textContent).toBe("Visible reasoning");
    act(() => view.root.render(card("Saved answer", "", "completed")));
    expect(view.container.querySelector(".showcase-term__answer")?.textContent).toBe("Saved answer");
  });
  it("responds to a preference change and preserves already visible text", () => {
    const change = motion(false);
    vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const view = render(<Smooth text="" />);
    act(() => view.root.render(<Smooth text="New output" />));
    change(true);
    expect(view.container.textContent).toBe("New output");
    change(false);
    expect(view.container.textContent).toBe("New output");
  });
  it("keeps animated catch-up for browsers that allow motion", () => {
    motion(false);
    let frame: FrameRequestCallback | undefined;
    vi.spyOn(performance, "now").mockReturnValue(0);
    vi.stubGlobal("requestAnimationFrame", vi.fn((cb: FrameRequestCallback) => { frame = cb; return 1; }));
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const view = render(<Smooth text="" />);
    act(() => view.root.render(<Smooth text="hello" />));
    expect(view.container.textContent).toBe("");
    act(() => frame?.(100));
    expect(view.container.textContent).toBe("he");
    act(() => frame?.(200));
    expect(view.container.textContent).toBe("hello");
  });
});
