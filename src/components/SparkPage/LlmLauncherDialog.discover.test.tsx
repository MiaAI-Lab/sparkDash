/**
 * Why this file exists: the Add-a-model dialog's discovery list is the entry
 * point for filling the launcher form from a host scan. A prefill bug (wrong
 * field, ollama directory left blank with no hint, list that never clears on
 * error) sends users to Save with bad data, so loading / empty / error states
 * and the per-kind prefill are pinned here.
 */
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, flush } from "../../testing/render";
import { LlmLauncherDialog, ModelDiscoveryList } from "./LlmLauncherDialog";
import { addLauncher, discoverModels, updateLauncher } from "../../api/client";
import type { ModelCandidate, ModelDiscoveryResponse } from "../../api/types";

vi.mock("../../api/client", () => ({
  addLauncher: vi.fn(),
  updateLauncher: vi.fn(),
  discoverModels: vi.fn(),
}));

const props = {
  open: true,
  sparkId: "spark-a",
  sparkName: "Spark A",
  onClose: vi.fn(),
  onSaved: vi.fn(),
};

const inputs = () => [...document.querySelectorAll("input")] as HTMLInputElement[];
const button = (text: string) =>
  [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === text) as HTMLButtonElement | undefined;
const click = async (el: Element) => act(async () => el.dispatchEvent(new MouseEvent("click", { bubbles: true })));

const scripted: ModelCandidate = {
  kind: "scripted",
  name: "glm-5.3",
  directory: "/home/spark/llms/glm-5.3",
  startScript: "start.sh",
  stopScript: "stop.sh",
};
const ollama: ModelCandidate = { kind: "ollama", name: "llama3.2:3b", size: "2.0 GB" };
const hf: ModelCandidate = {
  kind: "huggingface",
  name: "google/gemma-3-27b-it",
  directory: "~/.cache/huggingface/hub/models--google--gemma-3-27b-it",
};
const okResult: ModelDiscoveryResponse = {
  candidates: [scripted, ollama, hf],
  scannedRoots: ["$HOME", "$HOME/llms"],
  notes: [],
};

beforeEach(() => {
  vi.mocked(addLauncher).mockReset();
  vi.mocked(updateLauncher).mockReset();
  vi.mocked(discoverModels).mockReset();
});

describe("LlmLauncherDialog discovery", () => {
  it("scans, shows grouped candidates with badges, and prefills a scripted pick", async () => {
    let resolveScan!: (r: ModelDiscoveryResponse) => void;
    vi.mocked(discoverModels).mockReturnValue(
      new Promise<ModelDiscoveryResponse>((res) => {
        resolveScan = res;
      })
    );
    render(<LlmLauncherDialog {...props} />);
    await flush();
    // The scan starts on open now — the button is already in its scanning state.
    expect(button("Scanning…")).toBeTruthy();
    await act(async () => {
      resolveScan(okResult);
      await Promise.resolve();
    });
    const text = document.body.textContent || "";
    expect(text).toContain("launchable");
    expect(text).toContain("ollama weights");
    expect(text).toContain("HF cache");
    expect(text).toContain("glm-5.3");
    expect(text).toContain("2.0 GB");
    expect(text).toContain("google/gemma-3-27b-it");
    expect(text).toContain("Scanned $HOME, $HOME/llms");

    const rows = [...document.querySelectorAll(".model-discovery__row")];
    expect(rows.length).toBe(3);
    await click(rows[0]);
    expect(inputs()[0].value).toBe("glm-5.3");
    expect(inputs()[1].value).toBe("/home/spark/llms/glm-5.3");
  });

  it("prefills an ollama pick with the name only, leaving Directory blank with a hint", async () => {
    vi.mocked(discoverModels).mockResolvedValue(okResult);
    render(<LlmLauncherDialog {...props} />);
    await flush();
    const rows = [...document.querySelectorAll(".model-discovery__row")];
    await click(rows[1]);
    expect(inputs()[0].value).toBe("llama3.2:3b");
    expect(inputs()[1].value).toBe("");
    expect(document.body.textContent).toContain("Ollama keeps its weights in the engine");
  });

  it("prefills an HF pick with name and cache directory", async () => {
    vi.mocked(discoverModels).mockResolvedValue(okResult);
    render(<LlmLauncherDialog {...props} />);
    await flush();
    const rows = [...document.querySelectorAll(".model-discovery__row")];
    await click(rows[2]);
    expect(inputs()[0].value).toBe("google/gemma-3-27b-it");
    expect(inputs()[1].value).toBe("~/.cache/huggingface/hub/models--google--gemma-3-27b-it");
  });

  it("shows the empty message when the scan finds nothing", async () => {
    vi.mocked(discoverModels).mockResolvedValue({ candidates: [], scannedRoots: ["$HOME"], notes: [] });
    render(<LlmLauncherDialog {...props} />);
    await flush();
    expect(document.body.textContent).toContain("Nothing launchable found in the scanned folders");
  });

  it("shows an error state when the scan fails", async () => {
    vi.mocked(discoverModels).mockRejectedValue(new Error("Discovery scans the Spark that runs this dashboard"));
    render(<LlmLauncherDialog {...props} />);
    await flush();
    expect(document.body.textContent).toContain("Discovery failed: Discovery scans the Spark that runs this dashboard");
    expect(document.querySelector(".model-discovery__list")).toBeNull();
    // The user can try again.
    expect(button("Discover on this Spark")).toBeTruthy();
  });

  it("scans automatically for a new model and not when editing an existing one", async () => {
    vi.mocked(discoverModels).mockResolvedValue(okResult);
    render(<LlmLauncherDialog {...props} />);
    await flush();
    expect(discoverModels).toHaveBeenCalledTimes(1);
    const { container } = render(
      <LlmLauncherDialog
        {...props}
        launcher={{ id: "l1", name: "glm-5.3", dir: "/home/spark/llms/glm-5.3", startScript: "start.sh", stopScript: "stop.sh", port: null, notes: "" }}
      />
    );
    await flush();
    expect(discoverModels).toHaveBeenCalledTimes(1); // still one — editing does not re-scan
    expect(container.textContent).not.toContain("Scanned $HOME");
  });

  it("renders notes from degraded sources", () => {
    const { container } = render(
      <ModelDiscoveryList
        result={{ candidates: [scripted], scannedRoots: ["$HOME"], notes: ["ollama: docker not installed"] }}
        onPick={() => {}}
      />
    );
    expect(container.textContent).toContain("ollama: docker not installed");
  });
});
