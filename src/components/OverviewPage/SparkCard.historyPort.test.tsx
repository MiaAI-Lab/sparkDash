import { describe, expect, it, vi } from "vitest";
import { render } from "../../testing/render";
import { makeSpark } from "../../testing/fixtures";

vi.mock("../../api/client", () => ({ fetchLaunchers: () => new Promise(() => {}), runLauncher: vi.fn(), wakeSpark: vi.fn() }));
vi.mock("./OverviewLlmFooter", () => ({
  OverviewLlmFooter: ({ port }: { port: number | null }) => <div data-testid="history-port">{port ?? "unknown"}</div>,
}));
import { SparkCard } from "./SparkCard";

describe("overview history identity during port edits", () => {
  it("uses the measurement's port when configured ports were reordered", () => {
    const spark = makeSpark("fixture");
    spark.llmPorts = [8002, 8001];
    spark.metrics.llm[0].port = 8001;
    const { container } = render(<SparkCard spark={spark} temperatureUnit="celsius" />);
    expect(container.querySelector('[data-testid="history-port"]')?.textContent).toBe("8001");
  });

  it("does not fetch history for a removed measurement port", () => {
    const spark = makeSpark("fixture");
    spark.llmPorts = [8002];
    spark.metrics.llm[0].port = 8001;
    const { container } = render(<SparkCard spark={spark} temperatureUnit="celsius" />);
    expect(container.querySelector('[data-testid="history-port"]')?.textContent).toBe("unknown");
  });

  it("retains a positional fallback for legacy measurements without port identity", () => {
    const spark = makeSpark("fixture");
    spark.llmPorts = [8002, 8001];
    delete spark.metrics.llm[0].port;
    const { container } = render(<SparkCard spark={spark} temperatureUnit="celsius" />);
    expect(container.querySelector('[data-testid="history-port"]')?.textContent).toBe("8002");
  });
});
