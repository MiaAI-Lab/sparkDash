import { act } from "react";
import { describe, expect, it } from "vitest";
import { VramBreakdownBar } from "./VramBreakdownBar";
import { render } from "../../testing/render";
import { computeVramBreakdown } from "../../shared/vramBreakdown";

/** spark-1 as observed live (MB). */
const spark1 = (kvCacheUsage: number | null = 0.0549) =>
  computeVramBreakdown(
    { used: 101_008, total: 124_610, available: 7_412 },
    [{ pid: 92_271, name: "python3", vramMB: 101_008 }],
    {
      model: "unified",
      unified: { total: 124_610, gpuUsed: 101_008, cpuUsed: 16_190, available: 7_412 },
      serving: true,
      endpoint: { available: true, backend: "tensorfold", kvCacheUsage },
    },
  )!;

const rtx = (endpoint: Parameters<typeof computeVramBreakdown>[2]["endpoint"]) =>
  computeVramBreakdown(
    { used: 94_612, total: 97_887, available: 3_275 },
    [
      { pid: 4009, name: "sglang::scheduler", vramMB: 93_932 },
      { pid: 3824, name: "python", vramMB: 550 },
    ],
    { model: "discrete", unified: null, serving: true, endpoint },
  )!;

function parts(container: HTMLElement) {
  const group = container.querySelector<HTMLElement>("[data-vram-breakdown]")!;
  const tip = container.querySelector<HTMLElement>('[role="tooltip"]')!;
  return { group, tip };
}

const key = (el: HTMLElement, k: string) =>
  act(() => {
    el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));
  });

describe("VramBreakdownBar", () => {
  it("draws category segments and puts the severity on the headroom figure", () => {
    const { container } = render(<VramBreakdownBar label="Unified memory" breakdown={spark1()} showLegend />);
    const segs = Array.from(container.querySelectorAll<HTMLElement>("[data-segment]"));
    expect(segs.map((s) => s.dataset.segment)).toEqual(["engine", "system"]);
    expect(segs[0].className).toContain("mem-seg-engine");
    expect(segs[1].className).toContain("mem-seg-system");
    // 101008 / 124610 of the bar; no threshold colour on any segment
    expect(segs[0].style.getPropertyValue("--bar-pct")).toBe("81.06%");
    expect(container.querySelector(".bg-danger, .bg-warning, .bg-accent")).toBeNull();
    const headroom = container.querySelector<HTMLElement>("[data-headroom]")!;
    expect(headroom.textContent).toBe("7.2 GB free");
    expect(headroom.className).toContain("text-warning");
    expect(container.querySelector("[data-legend]")?.textContent).toBe(
      "Engine 98.6 · System 15.8 · Free 7.2 GB · KV 5%",
    );
  });

  it("leaves the legend out unless asked", () => {
    const { container } = render(<VramBreakdownBar label="VRAM" breakdown={spark1()} />);
    expect(container.querySelector("[data-legend]")).toBeNull();
  });

  it("marks a nearly full KV pool amber in the legend", () => {
    const { container } = render(
      <VramBreakdownBar label="VRAM" breakdown={spark1(0.93)} showLegend />,
    );
    const legend = container.querySelector("[data-legend]")!;
    const kv = Array.from(legend.querySelectorAll("span")).find((s) => s.textContent?.includes("KV 93%"));
    expect(kv?.className).toContain("text-warning");
  });

  it("opens the breakdown on keyboard focus, describes the bar with it, and closes on Escape", () => {
    const { container } = render(<VramBreakdownBar label="Unified memory" breakdown={spark1()} />);
    const { group, tip } = parts(container);
    expect(group.tabIndex).toBe(0);
    expect(group.getAttribute("aria-describedby")).toBe(tip.id);
    expect(tip.hidden).toBe(true);

    act(() => group.focus());
    expect(tip.hidden).toBe(false);
    const text = tip.textContent ?? "";
    expect(text).toContain("Unified memory · 114.5 GB of 121.7 GB used");
    expect(text).toContain("python3 · pid 92271");
    expect(text).toContain("98.6 GB");
    expect(text).toContain("KV in use 5%");
    expect(text).toContain("System / CPU 15.8 GB");
    expect(text).toContain("Free 7.2 GB");
    expect(text).not.toContain("Weights"); // TensorFold reports no GB split
    expect(tip.querySelector("[data-verdict]")?.textContent).toBe(
      "Low headroom: CPU-side growth could trigger the OOM killer",
    );

    key(group, "Escape");
    expect(tip.hidden).toBe(true);
    // Focus leaves and comes back: open again.
    act(() => group.blur());
    act(() => group.focus());
    expect(tip.hidden).toBe(false);
  });

  it("opens on hover too", () => {
    const { container } = render(<VramBreakdownBar label="VRAM" breakdown={spark1()} />);
    const { group, tip } = parts(container);
    act(() => {
      group.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    });
    expect(tip.hidden).toBe(false);
    act(() => {
      group.dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: document.body }));
    });
    expect(tip.hidden).toBe(true);
  });

  it("closes when something else takes over while the pointer stays still", () => {
    const { container } = render(<VramBreakdownBar label="VRAM" breakdown={spark1()} />);
    const { group, tip } = parts(container);
    const hover = () =>
      act(() => {
        group.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      });

    // A dialog opens (from the keyboard, or a prompt on its own) and takes focus:
    // no mouseleave ever fires, so focus moving outside has to close it.
    const dialogButton = document.createElement("button");
    document.body.appendChild(dialogButton);
    hover();
    expect(tip.hidden).toBe(false);
    act(() => dialogButton.focus());
    expect(tip.hidden).toBe(true);

    // A press inside the bar keeps it; a press anywhere else closes it.
    hover();
    act(() => {
      group.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    });
    expect(tip.hidden).toBe(false);
    act(() => {
      dialogButton.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    });
    expect(tip.hidden).toBe(true);

    // Scrolling or leaving the window closes it too.
    hover();
    act(() => {
      window.dispatchEvent(new Event("scroll"));
    });
    expect(tip.hidden).toBe(true);
    hover();
    act(() => {
      window.dispatchEvent(new Event("blur"));
    });
    expect(tip.hidden).toBe(true);

    dialogButton.remove();
  });

  it("lists SGLang's weights and KV pool, and says when a backend reports no KV fill", () => {
    const sg = render(
      <VramBreakdownBar
        label="VRAM"
        breakdown={rtx({ available: true, backend: "sglang", kvCacheUsage: 0, kvCacheGb: 10.729, weightsGb: 71.066 })}
      />,
    );
    const sgText = parts(sg.container).tip.textContent ?? "";
    expect(sgText).toContain("sglang::scheduler · pid 4009");
    expect(sgText).toContain("Weights 71.1 GB");
    expect(sgText).toContain("KV pool 10.7 GB");
    expect(sgText).toContain("KV in use 0%");
    expect(sgText).toContain("Other GPU 680 MB");
    expect(sgText).not.toContain("System / CPU");
    expect(sgText).toContain("Plenty of headroom");

    const vl = render(
      <VramBreakdownBar label="VRAM" breakdown={rtx({ available: true, backend: "vllm" })} />,
    );
    const vlTip = parts(vl.container).tip;
    expect(vlTip.textContent).toContain("KV in use not reported by vLLM");
  });
});
