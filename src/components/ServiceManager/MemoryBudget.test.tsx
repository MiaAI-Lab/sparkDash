import { describe, expect, it } from "vitest";
import { flush, render } from "../../testing/render";
import { MemoryBudget, type MemoryBudgetProps } from "./MemoryBudget";

function budget(overrides: Partial<MemoryBudgetProps> = {}): MemoryBudgetProps {
  return {
    totalMB: 131_072,
    usedMB: 110_000,
    freeMB: 21_072,
    servicesUsedMB: 102_400,
    otherUsedMB: 7_600,
    services: [
      { name: "llm-tp1", kind: "llm", footprintMB: 102_400, running: true, needed: true },
      { name: "image-sd", kind: "image", footprintMB: 40_960, running: true, needed: false },
    ],
    makeRoom: [{ serviceName: "image-sd", freesMB: 40_960, reason: "low-priority" }],
    needMakeRoom: true,
    ...overrides,
  };
}

describe("MemoryBudget", () => {
  it("renders total, used, free, services used, other used, service rows, and make-room plan", async () => {
    const { container } = render(<MemoryBudget {...budget()} />);
    await flush();
    const text = container.textContent ?? "";
    expect(text).toContain("Memory Budget");
    expect(text).toContain("128.0 GB"); // total
    expect(text).toContain("107.4 GB / 128.0 GB"); // used bar caption
    expect(text).toContain("20.6 GB"); // free
    expect(text).toContain("100.0 GB"); // services used
    expect(text).toContain("7.4 GB"); // other used
    expect(text).toContain("llm-tp1");
    expect(text).toContain("(llm)");
    expect(text).toContain("100.0 GB · running · needed");
    expect(text).toContain("image-sd");
    expect(text).toContain("(image)");
    expect(text).toContain("40.0 GB · running");
    expect(text).toContain("Make-room plan");
    expect(text).toContain("low-priority");
    expect(text).toContain("+40.0 GB");
    expect(text).toContain("Make room needed");
  });

  it("shows the OK badge and hides the make-room / services sections when not needed", async () => {
    const { container } = render(
      <MemoryBudget {...budget({ needMakeRoom: false, makeRoom: [], services: [] })} />
    );
    await flush();
    const text = container.textContent ?? "";
    expect(text).toContain("OK");
    expect(text).not.toContain("Make room needed");
    expect(text).not.toContain("Make-room plan");
    expect(text).not.toContain("(llm)"); // no service rows
  });
});
