import { act } from "react";
import { describe, expect, it } from "vitest";
import { BenchTargetFrame } from "./BenchTargetFrame";
import { makeSpark } from "../../../testing/fixtures";
import { render } from "../../../testing/render";

describe("BenchTargetFrame live throughput", () => {
  it("passes an unknown loaded model rate as null while retaining its benchmark target", () => {
    const spark = makeSpark();
    Object.assign(spark.metrics.llm[0], { backend: "ollama", liveRatesAvailable: false, generationTps: 0 });
    const body = (target: { liveTps: number | null; modelId: string | null }) => <output>{JSON.stringify(target)}</output>;
    const { container, root } = render(<BenchTargetFrame spark={spark}>{body}</BenchTargetFrame>);
    const target = () => JSON.parse(container.querySelector("output")!.textContent!);
    expect(target()).toMatchObject({ liveTps: null, modelId: "fixture-model", engine: "ollama", llmPort: 8888 });
    expect(container.querySelector(".bp-notice")).toBeNull();
    Object.assign(spark.metrics.llm[0], { backend: "vllm", liveRatesAvailable: true, generationTps: 20 });
    act(() => root.render(<BenchTargetFrame spark={spark}>{body}</BenchTargetFrame>));
    expect(target().liveTps).toBe(20);
    spark.metrics.llm[0].available = false;
    act(() => root.render(<BenchTargetFrame spark={spark}>{body}</BenchTargetFrame>));
    expect(target().liveTps).toBeNull();
  });
});
