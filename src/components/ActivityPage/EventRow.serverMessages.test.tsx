import { act } from "react";
import { afterEach, expect, it } from "vitest";
import type { ActivityEvent } from "../../api/types";
import { setLocale } from "../../i18n";
import { render } from "../../testing/render";
import { EventRow } from "./EventRow";

afterEach(async () => { await act(() => setLocale("en")); });

it("keeps translated detail labels and raw evidence alongside a translated summary", async () => {
  await act(() => setLocale("en"));
  const event: ActivityEvent = {
    id: 1, ts: 1_000, type: "spark.offline", severity: "error",
    sparkId: "raw-id", sparkName: "Raw <host>", message: "Raw <host> went offline",
    data: { diagnostic: "raw <error>" },
    i18n: { message: { key: "event.sparkOffline", params: { name: "Raw <host>" } } },
  };
  const { container } = render(<EventRow event={event} open fresh={false} now={2_000} onToggle={() => {}} />);
  await act(() => setLocale("zh-CN"));
  expect(container.querySelector(".ac-row__msg")?.textContent).toBe("Raw <host> 已离线");
  expect([...container.querySelectorAll("dt")].map(n => n.textContent)).toEqual([
    "消息", "时间", "严重级别", "类型", "事件 ID", "Spark", "类别", "数据复制",
  ]);
  expect(container.querySelector(".ac-detail__wide dd")?.textContent).toBe(event.message);
  expect(container.querySelector(".ac-detail__data")?.textContent).toContain("raw <error>");
  expect(container.querySelector("host, error")).toBeNull();
  await act(() => setLocale("en"));
  expect(container.querySelector(".ac-row__msg")?.textContent).toBe(event.message);
});
