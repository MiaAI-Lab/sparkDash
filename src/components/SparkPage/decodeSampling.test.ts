import { expect, it } from "vitest";
import { decodeBenchSamplingLabel, decodeBenchSamplingMixed } from "./decodeSampling";

it("records TensorFold's top_k in sampling labels and comparison compatibility", () => {
  const plain = { temperature: 0.7, thinking: true };
  const tensorfold = { ...plain, topK: 20 };
  expect(decodeBenchSamplingLabel(plain)).toBe("temp 0.7 · thinking on");
  expect(decodeBenchSamplingLabel(tensorfold)).toBe("temp 0.7 · thinking on · top_k 20");
  expect(decodeBenchSamplingMixed([plain, tensorfold])).toBe(true);
  expect(decodeBenchSamplingMixed([tensorfold, tensorfold])).toBe(false);
  expect(decodeBenchSamplingLabel(undefined)).toBe("temp 0 · thinking off");
});
