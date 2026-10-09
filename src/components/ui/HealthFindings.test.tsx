import { render } from "../../testing/render";
import { describe, expect, it } from "vitest";
import type { HealthFinding } from "../../api/types";
import { HealthChips, HealthList, sortFindings, worstSeverity } from "./HealthFindings";

const f = (id: HealthFinding["id"], severity: HealthFinding["severity"]): HealthFinding => ({
  id,
  severity,
  title: `T-${id}`,
  detail: `D-${id}`,
  hint: `H-${id}`,
});

describe("HealthFindings", () => {
  it("sorts critical first, then by id", () => {
    expect(sortFindings([f("memory", "warn"), f("xid", "critical"), f("link-speed", "warn")]).map((x) => x.id)).toEqual([
      "xid",
      "link-speed",
      "memory",
    ]);
    expect(sortFindings(undefined)).toEqual([]);
  });

  it("worstSeverity picks critical over warn", () => {
    expect(worstSeverity([f("memory", "warn"), f("xid", "critical")])).toBe("critical");
    expect(worstSeverity([f("memory", "warn")])).toBe("warn");
    expect(worstSeverity([])).toBeNull();
  });

  it("renders nothing when healthy", () => {
    expect(render(<HealthChips findings={[]} />).container.firstChild).toBeNull();
    expect(render(<HealthList findings={undefined} />).container.firstChild).toBeNull();
  });

  it("chips show two titles and a +N more, with detail and hint in the tooltip", () => {
    const { container } = render(
      <HealthChips findings={[f("xid", "critical"), f("memory", "warn"), f("thermal", "warn"), f("oom", "critical")]} />
    );
    const rows = [...container.querySelectorAll(".health-row, .health-more")];
    expect(rows.map((t) => t.textContent?.trim())).toEqual(["T-oom", "T-xid", "+2 more"]);
    expect(rows[1].getAttribute("title")).toBe("D-xid H-xid");
  });

  it("the list shows title, evidence and what to try", () => {
    const { container } = render(<HealthList findings={[f("thermal", "warn")]} />);
    const text = container.textContent ?? "";
    expect(text).toContain("T-thermal");
    expect(text).toContain("D-thermal");
    expect(text).toContain("H-thermal");
    expect(text).toContain("Warning");
  });
});
