import test from "node:test";
import assert from "node:assert/strict";
import { getOverviewLlmStat } from "../src/components/OverviewPage/overviewLlmStat.ts";

const noLlm = { llm: [] };

test("distributed worker uses its cluster label on the overview card", () => {
  const stat = getOverviewLlmStat({
    llmCluster: {
      label: "DeepSeek V4 Flash",
      role: "worker",
      headSparkId: "spark-05",
      headPort: 8888,
      rank: 1,
      worldSize: 2,
    },
    metrics: noLlm,
  });

  assert.deepEqual(stat, {
    label: "Distributed worker",
    value: "DeepSeek V4 Flash",
    title: "DeepSeek V4 Flash distributed worker · rank 1 / 1",
  });
});

test("available local LLM keeps the existing overview stat", () => {
  const stat = getOverviewLlmStat({
    llmCluster: null,
    metrics: {
      llm: [{
        available: true,
        backend: "vllm",
        modelId: "glm-5.2",
        modelPath: null,
        contextLength: null,
        gpuMemoryUtilization: null,
        slotsActive: 0,
        slotsTotal: 0,
        generationTps: 0,
        prefillTps: 0,
        totalOutputTokens: 0,
        error: null,
      }],
    },
  });

  assert.deepEqual(stat, {
    label: "vLLM",
    value: "glm-5.2",
    title: "glm-5.2",
  });
});
