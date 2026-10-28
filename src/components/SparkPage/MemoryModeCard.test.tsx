import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchMemoryMode = vi.fn();
const setMemoryMode = vi.fn();
vi.mock("../../api/client", () => ({
  fetchMemoryMode: (...a: unknown[]) => fetchMemoryMode(...a),
  setMemoryMode: (...a: unknown[]) => setMemoryMode(...a),
}));

import type { MemoryModeStatus } from "../../api/types";
import { flush, render } from "../../testing/render";
import { MemoryModeCard } from "./MemoryModeCard";

const status = (over: Partial<MemoryModeStatus> = {}): MemoryModeStatus => ({
  enabled: true,
  problem: null,
  mode: "ollama",
  qwen: "exited",
  ollamaStack: [
    { name: "spark-ollama-engine", state: "running" },
    { name: "librechat", state: "running" },
    { name: "chat-mongodb", state: "running" },
  ],
  availableGb: 95.4,
  memoryFloorGb: 108,
  busy: false,
  ...over,
});

const button = (root: ParentNode, text: string) =>
  [...root.querySelectorAll("button")].find((b) => b.textContent?.trim().startsWith(text));

function typeInput(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  act(() => {
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function confirmSwitch(mode: "qwen" | "ollama") {
  const target = button(document.body, mode === "ollama" ? "Ollama stack" : "Qwen stack");
  expect(target).toBeTruthy();
  await act(async () => void target!.click());
  await flush();
  const dialog = document.querySelector('[role="dialog"]');
  expect(dialog).toBeTruthy();
  const phrase = dialog!.querySelector('input[type="text"]') as HTMLInputElement;
  const ack = dialog!.querySelector('input[type="checkbox"]') as HTMLInputElement;
  typeInput(phrase, "switch");
  await act(async () => void ack.click());
  const go = button(dialog!, mode === "ollama" ? "Switch to Ollama" : "Switch to Qwen");
  expect(go).toBeTruthy();
  expect((go as HTMLButtonElement).disabled).toBe(false);
  await act(async () => void go!.click());
  await flush();
}

beforeEach(() => {
  document.body.innerHTML = "";
  fetchMemoryMode.mockReset();
  setMemoryMode.mockReset();
});

describe("MemoryModeCard", () => {
  it("renders nothing while the feature is disabled on the server", async () => {
    fetchMemoryMode.mockResolvedValue(status({ enabled: false, mode: "none", qwen: null, busy: false }));
    const { container } = render(<MemoryModeCard />);
    await flush();
    expect(container.textContent).toBe("");
  });

  it("shows both stacks, the container states and the available-memory readout", async () => {
    fetchMemoryMode.mockResolvedValue(status());
    const { container } = render(<MemoryModeCard />);
    await flush();
    expect(button(container, "Qwen stack")).toBeTruthy();
    expect(button(container, "Ollama stack")).toBeTruthy();
    expect(container.textContent).toContain("95.4 GB free");
    expect(container.textContent).toContain("floor 108 GB");
    expect(container.textContent).toContain("librechat running");
  });

  it("confirming the switch POSTs the chosen mode", async () => {
    fetchMemoryMode.mockResolvedValue(status());
    setMemoryMode.mockResolvedValue({ status: "success", message: "Qwen verified stopped; Ollama stack verified running." });
    const { container } = render(<MemoryModeCard />);
    await flush();
    await confirmSwitch("ollama");
    expect(setMemoryMode).toHaveBeenCalledWith("ollama");
    // The server's honest message is shown verbatim.
    expect(container.textContent).toContain("Qwen verified stopped; Ollama stack verified running.");
  });

  it("renders a server error message verbatim, including the memory-floor refusal", async () => {
    fetchMemoryMode.mockResolvedValue(status());
    const refusal =
      "Memory floor breach: 50GB available after the stack stopped and memory settled (< 108GB floor). Something else is holding RAM. Qwen NOT launched.";
    setMemoryMode.mockResolvedValue({ status: "error", message: refusal });
    const { container } = render(<MemoryModeCard />);
    await flush();
    await confirmSwitch("qwen");
    expect(setMemoryMode).toHaveBeenCalledWith("qwen");
    expect(container.textContent).toContain(refusal);
  });

  it("arms the button only after the phrase is typed", async () => {
    fetchMemoryMode.mockResolvedValue(status());
    const { container } = render(<MemoryModeCard />);
    await flush();
    const target = button(container, "Ollama stack");
    await act(async () => void target!.click());
    await flush();
    const dialog = document.querySelector('[role="dialog"]');
    const go = button(dialog!, "Switch to Ollama");
    expect((go as HTMLButtonElement).disabled).toBe(true);
    const ack = dialog!.querySelector('input[type="checkbox"]') as HTMLInputElement;
    await act(async () => void ack.click());
    expect((go as HTMLButtonElement).disabled).toBe(true);
    typeInput(dialog!.querySelector('input[type="text"]') as HTMLInputElement, "switch");
    expect((go as HTMLButtonElement).disabled).toBe(false);
    expect(setMemoryMode).not.toHaveBeenCalled();
  });
});
