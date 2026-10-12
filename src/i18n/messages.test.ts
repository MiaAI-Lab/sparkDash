import { afterEach, expect, it } from "vitest";
import type { ActivityEvent, HealthFinding } from "../api/types";
import { setLocale } from ".";
import { localizedActivityMessage, localizedHealthField, localizedServerText, localizedServerMessage } from "./messages";
import { applicationTextI18n } from "../shared/applicationText.js";
import { exportText, filterEvents, EMPTY_FILTER, typeLabel } from "../components/ActivityPage/activityStats";
import { formatRelativeTime } from "../components/OverviewPage/activityFormat";

afterEach(async () => { await setLocale("en", { persist: false }); });

it("keeps the original English event message when no descriptor exists", () => {
  expect(localizedActivityMessage({ type: "external.error", message: "SSH timed out" })).toBe("SSH timed out");
});

it("renders a structured activity event in the browser locale", async () => {
  const event: Pick<ActivityEvent, "message" | "i18n" | "type"> = {
    type: "spark.online",
    message: "Spark 1 came online",
    i18n: { message: { key: "activity.message.sparkOnline", params: { name: "Spark 1" } } },
  };
  expect(localizedActivityMessage(event)).toBe("Spark 1 came online");
  await setLocale("zh-Hans", { persist: false });
  expect(localizedActivityMessage(event)).toBe("Spark 1 已上线");
});

it("localizes historical stable event types without changing their stored English", async () => {
  const event: Pick<ActivityEvent, "type" | "message" | "sparkName"> = { type: "spark.online", message: "Spark 1 came online", sparkName: "Spark 1" };
  expect(localizedActivityMessage(event)).toBe("Spark 1 came online");
  await setLocale("zh-Hans", { persist: false });
  expect(localizedActivityMessage(event)).toBe("Spark 1 已上线");
});

it("uses translated health metadata but keeps unknown fields raw", async () => {
  const finding: HealthFinding = {
    id: "thermal", severity: "warn", title: "GPU is running hot", detail: "86°C.", hint: "Check airflow.",
    i18n: { title: { key: "health.thermal.title.warn" }, detail: { key: "health.thermal.detail" }, hint: { key: "health.thermal.hint" } },
  };
  await setLocale("zh-Hans", { persist: false });
  expect(localizedHealthField(finding, "title")).toBe("GPU 温度过高");
  expect(localizedHealthField(finding, "detail")).toBe("86°C.");
  await setLocale("en", { persist: false });
  expect(localizedHealthField(finding, "detail")).toBe("86°C.");
});

it.each([
  ["Running concurrency 8…", "并发数 8"],
  ["Prefilling 16k (run 2/3)…", "16k（第 2/3 次）"],
  ["Opening SSH tunnel to 127.0.0.1:8000…", "127.0.0.1:8000"],
  ["Reaching LLM on 10.0.0.2:8000…", "10.0.0.2:8000"],
  ["Long-context recall 32k…", "长上下文召回 32k"],
  ["maxTokens must be between 10 and 512", "10 和 512"],
  ["Invalid or disallowed host: 10.0.0.2", "10.0.0.2"],
  ["Installed (0.8.2)", "已安装（0.8.2）"],
  ["Enter a host", "请输入主机地址"],
  ["Invalid URL", "URL 无效"],
  ["Trials must be at least 1", "重复次数不能小于 1"],
  ["Open · Local", "开放 · 本机"],
  ["Bad API key", "API 密钥无效"],
  ["HW thermal slowdown · SW power cap", "硬件热降频 · 软件功率限制"],
  ["3/4 keys, 1 stale", "3/4 个键，1 个过期"],
  ["Unauthenticated · loopback target (127.0.0.1). Based on the configured probe host, not the process bind address.", "依据配置的探测主机判断，并非进程绑定地址"],
])("recognizes authored dynamic and validation text: %s", async (raw, expected) => {
  const meta = applicationTextI18n(raw);
  expect(meta).toBeDefined();
  expect(localizedServerMessage(meta, raw)).toBe(raw);
  await setLocale("zh-Hans", { persist: false });
  expect(localizedServerText(raw)).toContain(expected);
  expect(localizedServerText(raw)).toBe(localizedServerMessage(meta, raw));
});

it("retains complete multiline diagnostics and supports immediate locale switches", async () => {
  const raw = "ssh: permission denied\nNVRM Xid 79\nlast diagnostic line\n";
  const meta = { key: "server.error.unexpected", params: { detail: raw } };
  expect(localizedServerMessage(meta, raw)).toBe(raw);
  await setLocale("zh-Hans", { persist: false });
  expect(localizedServerText(raw)).toContain(raw);
  expect(localizedServerMessage(meta, raw)).toContain(raw);
  await setLocale("en", { persist: false });
  expect(localizedServerMessage(meta, raw)).toBe(raw);
});

it("does not wrap already translated validation text in another error summary", async () => {
  await setLocale("zh-Hans", { persist: false });
  expect(localizedServerText("请先填写主机地址")).toBe("请先填写主机地址");
});

it("merges partial metadata with recognized raw text and preserves unrecognized diagnostic tails", async () => {
  await setLocale("zh-Hans", { persist: false });
  const raw = "ssh: permission denied\nlast line\n";
  expect(localizedServerMessage({ key: "server.error.unexpected" }, raw)).toContain(raw);
  expect(localizedServerMessage({ key: "server.progress.concurrency" }, "Running concurrency 8…")).toContain("8");
  expect(localizedServerMessage({ key: "server.error.maxTokens", params: { min: 10 } }, "maxTokens must be between 10 and 512")).toContain("10 和 512");
  expect(localizedServerMessage({ key: "server.progress.concurrency" }, raw)).toBe(raw);
  expect(localizedServerMessage({ key: "external.future" }, raw)).toContain(raw);
  const finding: HealthFinding = { id: "thermal", severity: "warn", title: "GPU is running hot", detail: "86°C. last diagnostic line", hint: "", i18n: { title: { key: "health.thermal.title.warn" }, detail: { key: "health.thermal.detail", params: { temperature: 86 } }, hint: { key: "health.thermal.hint" } } };
  expect(localizedHealthField(finding, "detail")).toBe(finding.detail);
});

it("uses version suffixes after the complete Spark name", async () => {
  await setLocale("zh-Hans", { persist: false });
  const sparkName = "ssh to server";
  expect(localizedActivityMessage({ type: "hermes.update.success", sparkName, message: `Hermes updated on ${sparkName}` })).toBe(`${sparkName} 的 Hermes 已更新`);
  expect(localizedActivityMessage({ type: "hermes.update.success", sparkName, message: `Hermes updated on ${sparkName} to 0.8.2` })).toContain("版本 0.8.2");
});

it("retains health thresholds, metrics, latest kernel detail and RoCE physical states", async () => {
  const thermal: HealthFinding = { id: "thermal", severity: "warn", title: "GPU is running hot", detail: "86°C (warns at 85°C, critical at 90°C).", hint: "Check airflow." };
  const xid: HealthFinding = { id: "xid", severity: "critical", title: "NVIDIA Xid error", detail: "A GPU or driver error was logged by the kernel within the last hour (4 since boot). Latest: Xid 79, PCI 0000:01:00.0.", hint: "" };
  const roce: HealthFinding = { id: "roce-link", severity: "critical", title: "2 RoCE links went down", detail: "eth0: DOWN (Disabled), eth1: DOWN (Polling).", hint: "" };
  expect(localizedHealthField(xid, "detail")).toBe(xid.detail);
  await setLocale("zh-Hans", { persist: false });
  expect(localizedHealthField(thermal, "detail")).toBe("温度 86°C（警告阈值 85°C，严重阈值 90°C）。");
  expect(localizedHealthField(xid, "detail")).toContain("Xid 79, PCI 0000:01:00.0");
  expect(localizedHealthField(roce, "title")).toContain("2 条");
  expect(localizedHealthField(roce, "detail")).toContain("eth0: DOWN (Disabled), eth1: DOWN (Polling)");
});

it.each([
  ["power.shutdown", "Shutdown requested for Spark 1", "已请求关闭"],
  ["power.wake", "Wake-on-LAN sent to Spark 1", "网络唤醒包"],
  ["hermes.update.success", "Hermes updated on Spark 1 to 0.8.2", "版本 0.8.2"],
  ["hermes.update.error", "Hermes update failed on Spark 1", "更新失败"],
  ["hermes.update.available", "Hermes update available on Spark 1 (3 commits behind)", "落后 3 个提交"],
  ["gpu.throttle.thermal", "Spark 1 started thermal throttling (86°C)", "86°C"],
  ["bench.quality.finished", "Quality bench finished on Spark 1: 86.2%", "86.2%"],
  ["bench.decode.failed", "Decode bench failed on Spark 1: SSH timed out", "SSH timed out"],
  ["llm.start.requested", "Starting Qwen", "正在启动 Qwen"],
  ["llm.stop.failed", "Qwen: stop script failed (exit 2)", "退出码 2"],
  ["llm.attach.cancelled", "Closed output of Qwen", "已关闭 Qwen"],
  ["health.cleared", "Spark 1: GPU temperature is back to normal", "GPU 温度 已恢复正常"],
  ["health.xid", "NVIDIA Xid error: 2 new since the last check (Xid 79)", "新增 2 次 (Xid 79)"],
  ["health.thermal", "Spark 1: GPU is running hot — 86°C (warns at 85°C, critical at 90°C).", "警告阈值 85°C"],
])("renders historical %s events without mutating records", async (type, message, expected) => {
  const event: ActivityEvent = { id: 1, ts: 1, type, severity: "info", sparkName: "Spark 1", message };
  const before = JSON.stringify(event);
  expect(localizedActivityMessage(event)).toBe(message);
  await setLocale("zh-Hans", { persist: false });
  expect(localizedActivityMessage(event)).toContain(expected);
  expect(JSON.stringify(event)).toBe(before);
});

it("localizes event exports, search, stages and compact relative times", async () => {
  const event: ActivityEvent = { id: 1, ts: 1, type: "spark.online", severity: "success", sparkName: "Spark 1", message: "Spark 1 came online" };
  expect(formatRelativeTime(1000, 301000)).toBe("5m");
  await setLocale("zh-Hans", { persist: false });
  expect(exportText([event], "UTC")).toContain("Spark 1 已上线");
  expect(filterEvents([event], { ...EMPTY_FILTER, query: "上线" }, 1000)).toEqual([event]);
  expect(typeLabel("llm.start.requested")).toContain("已请求");
  expect(formatRelativeTime(1000, 301000)).toBe("5分钟");
});

it("localizes persisted application strings but keeps English and unknown detail intact", async () => {
  expect(localizedServerText("Cancelled by user")).toBe("Cancelled by user");
  await setLocale("zh-Hans", { persist: false });
  expect(localizedServerText("Cancelled by user")).toBe("已由用户取消");
  expect(localizedServerText("ssh timed out")).toContain("ssh timed out");
});
