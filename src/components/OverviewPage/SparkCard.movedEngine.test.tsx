import { describe, expect, it, vi } from "vitest";
import { SparkCard } from "./SparkCard";
import { makeSpark } from "../../testing/fixtures";
import { render } from "../../testing/render";

vi.mock("../../api/client", () => ({
  fetchLaunchers: () => new Promise(() => {}),
  runLauncher: vi.fn(),
  wakeSpark: vi.fn(),
}));

function headWithMovedEngine() {
  const spark = makeSpark("spark1");
  Object.assign(spark, {
    role: "head",
    online: true,
    llmMovedTo: {
      workerId: "spark2",
      workerName: "Spark 2",
      port: 8888,
      modelId: "DeepSeek-V4.1-Flash-1017",
      backend: "tensorfold",
      message:
        "Spark 2 answers on port 8888 (DeepSeek-V4.1-Flash-1017) while Spark 1 does not. " +
        "The engine may have moved to the worker — swap head and worker?",
    },
  });
  // The head's own ports answered nothing, which is what triggers the hint.
  spark.metrics.llm = spark.metrics.llm.map((entry) => ({ ...entry, available: false }));
  return spark;
}

describe("SparkCard when the engine answers on the paired worker", () => {
  it("names the worker, the port and the model instead of asserting the head has none", () => {
    const { container } = render(<SparkCard spark={headWithMovedEngine()} temperatureUnit="celsius" />);
    expect(container.textContent).toMatch(/Engine on the worker/);
    expect(container.textContent).toMatch(/Spark 2 answers on port 8888/);
    expect(container.textContent).toMatch(/DeepSeek-V4\.1-Flash-1017/);
    expect(container.textContent).toMatch(/swap head and worker\?/);
    expect(container.querySelector(".ov-launch--moved")).not.toBeNull();
  });

  it("shows no hint when the head's own engine answers", () => {
    const spark = makeSpark("spark1");
    Object.assign(spark, { role: "head", online: true });
    const { container } = render(<SparkCard spark={spark} temperatureUnit="celsius" />);
    expect(container.textContent).not.toMatch(/Engine on the worker/);
    expect(container.querySelector(".ov-launch--moved")).toBeNull();
  });
});
