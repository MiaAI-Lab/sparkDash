import { act } from "react";
import { render } from "../../testing/render";
import { describe, expect, it } from "vitest";
import type { HealthFinding } from "../../api/types";
import { setLocale } from "../../i18n";
// @ts-expect-error The plain JavaScript server module has no TypeScript declaration.
import { HealthEvaluator } from "../../../server/health/HealthEvaluator.js";
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

  it.each([
    { temperature: 86, severity: "warn", label: "警告", title: "GPU 温度过高" },
    { temperature: 92, severity: "critical", label: "严重", title: "GPU 温度接近关机阈值" },
  ])("renders an evaluator-generated $severity thermal finding in Chinese", async ({ temperature, severity, label, title }) => {
    const evaluator = new HealthEvaluator({ thresholds: () => ({ warnC: 85.5, criticalC: 90.5 }) });
    const findings: HealthFinding[] = evaluator.evaluate({ gpu: { temperature } }, "gpu");
    expect(findings).toHaveLength(1);
    const [finding] = findings;
    expect(finding).toMatchObject({ id: "thermal", severity });

    const { container } = render(<><HealthList findings={findings} /><HealthChips findings={findings} /></>);
    const list = container.querySelector(".health-list");
    const chip = container.querySelector(".health-row");
    expect(list?.textContent).toContain(finding.title);
    expect(list?.textContent).toContain(finding.detail);
    expect(list?.textContent).toContain(finding.hint);
    try {
      await act(() => setLocale("zh-CN"));
      const detail = `当前 ${temperature}°C（警告阈值 85.5°C，严重阈值 90.5°C）。`;
      expect(list?.textContent).toContain(`${label}${title}`);
      expect(list?.textContent).toContain(detail);
      expect(list?.textContent).toContain("确认通风口没有堵塞");
      expect(chip?.textContent).toContain(title);
      expect(chip?.getAttribute("title")).toContain(detail);
    } finally {
      await act(() => setLocale("en"));
    }
  });

  it("retranslates thermal warnings and critical findings while retaining custom diagnostics", async () => {
    const hint = "Check airflow and the room temperature, and that nothing blocks the vents. Lower the power limit or the load if it keeps climbing.";
    const warning: HealthFinding = {
      ...f("thermal", "warn"),
      title: "GPU is running hot",
      detail: "86°C (warns at 85°C, critical at 90°C).",
      hint,
    };
    const critical: HealthFinding = {
      ...warning,
      severity: "critical",
      title: "GPU is close to its shutdown temperature",
      detail: "92°C (warns at 85.5°C, critical at 90.5°C).",
    };
    const custom: HealthFinding = { ...warning, detail: "Custom sensor detail <raw>", hint: "Custom diagnostic hint" };
    const { container } = render(
      <>
        <HealthList findings={[warning]} />
        <HealthList findings={[critical]} />
        <HealthList findings={[custom]} />
        <HealthChips findings={[warning]} />
      </>
    );
    expect(container.textContent).toContain(warning.detail);
    try {
      await act(() => setLocale("zh-CN"));
      const [warningList, criticalList, customList] = container.querySelectorAll(".health-list");
      expect(warningList.textContent).toContain("警告GPU 温度过高");
      expect(warningList.textContent).toContain("当前 86°C（警告阈值 85°C，严重阈值 90°C）。");
      expect(warningList.textContent).toContain("确认通风口没有堵塞");
      expect(criticalList.textContent).toContain("严重GPU 温度接近关机阈值");
      expect(criticalList.textContent).toContain("当前 92°C（警告阈值 85.5°C，严重阈值 90.5°C）。");
      expect(customList.textContent).toContain(custom.detail);
      expect(customList.textContent).toContain(custom.hint);
      expect(container.querySelector(".health-row")?.getAttribute("title")).toContain("当前 86°C");
    } finally {
      await act(() => setLocale("en"));
    }
    expect(container.textContent).toContain(warning.detail);
    expect(container.textContent).toContain(warning.hint);
  });
});
