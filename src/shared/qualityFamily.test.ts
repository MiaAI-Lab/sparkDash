import { describe, expect, it } from "vitest";
import { qualityFamilyKey } from "./qualityBench.js";

describe("qualityFamilyKey", () => {
  it("strips paths, case and quantisation suffixes so builds of one model share a reference", () => {
    expect(qualityFamilyKey("GLM-5.3-Flash")).toBe("glm-5.3-flash");
    expect(qualityFamilyKey("GLM-5.3-Flash-FP8")).toBe("glm-5.3-flash");
    expect(qualityFamilyKey("glm-5.3-flash-exl3-4bit")).toBe("glm-5.3-flash");
    expect(qualityFamilyKey("/models/Qwen3-8B-AWQ")).toBe("qwen3-8b");
    expect(qualityFamilyKey("qwen3-8b-Q4_K_M.gguf")).toBe("qwen3-8b");
    expect(qualityFamilyKey("Llama-3.1-8B-Instruct-bf16")).toBe("llama-3.1-8b-instruct");
    expect(qualityFamilyKey("MiniMax-M2.5-NVFP4-dynamic")).toBe("minimax-m2.5");
    expect(qualityFamilyKey("")).toBe("");
    expect(qualityFamilyKey(null)).toBe("");
  });
});
