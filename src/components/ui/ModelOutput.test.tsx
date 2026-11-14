import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { render, flush } from "../../testing/render";
import { AUTOSHOW_KEY, ModelOutput } from "./ModelOutput";

const button = (root: HTMLElement, text: string) => [...root.querySelectorAll("button")].find(b => b.textContent === text)!;
describe("model operation output", () => {
  it("preserves hidden and expanded output across the dashboard-to-agent UUID handoff", async () => {
    localStorage.clear();
    const { container, root } = render(<ModelOutput operationId="dashboard" output="Accepted" running />);
    await flush();
    act(() => button(container, "Hide output").click());
    act(() => root.render(<ModelOutput operationId="agent" output="Starting" running />));
    await flush();
    expect(container.querySelector('[role="log"]')).toBeNull();
    act(() => button(container, "Show output").click());
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="Expand output"]')!.click());
    act(() => root.render(<ModelOutput operationId="agent-next" output="Waiting for readiness" running={false} />));
    await flush();
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 260)); });
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Waiting for readiness");
    act(() => root.render(<ModelOutput operationId="agent-next" output="Ready" running={false} />));
    await flush();
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Ready");
    act(() => document.querySelector<HTMLButtonElement>('[aria-label="Close output"]')!.click());
    act(() => button(container, "Hide output").click());
    act(() => root.render(<ModelOutput operationId="another-action" output="Stopping" running />));
    await flush();
    expect(container.querySelector('[role="log"]')?.textContent).toContain("Stopping");
  });
  it("shows live output, allows hiding, copying and expanding, without changing the operation", async () => {
    localStorage.clear();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const { container } = render(<ModelOutput operationId="one" output={"Stopping previous model\nWaiting for readiness"} running />);
    await flush();
    expect(container.querySelector('[role="log"]')?.textContent).toContain("Waiting for readiness");
    await act(async () => button(container, "Copy").click());
    expect(writeText).toHaveBeenCalledWith("Stopping previous model\nWaiting for readiness");
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="Expand output"]')!.click());
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Stopping previous model");
    act(() => document.querySelector<HTMLButtonElement>('[aria-label="Close output"]')!.click());
    act(() => button(container, "Hide output").click());
    expect(container.querySelector('[role="log"]')).toBeNull();
    act(() => button(container, "Show output").click());
    expect(container.querySelector('[role="log"]')).not.toBeNull();
  });
  it("respects the saved output preference and reports clipboard failure", async () => {
    localStorage.setItem(AUTOSHOW_KEY, "0");
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) } });
    const { container } = render(<ModelOutput operationId="two" output="Failed readiness" running={false} />);
    await flush();
    expect(container.querySelector('[role="log"]')).toBeNull();
    act(() => button(container, "Show output").click());
    await act(async () => button(container, "Copy").click());
    expect(container.textContent).toContain("Could not copy output");
    localStorage.clear();
  });
});
