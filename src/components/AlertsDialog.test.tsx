import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AlertsDialog } from "./AlertsDialog";
import type { AlertsConfig, AlertsResponse } from "../api/types";
import { flush, render } from "../testing/render";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const MASKED = "https://ntfy.sh…ab12";

function baseConfig(): AlertsConfig {
  return {
    enabled: true,
    repeatIntervalMin: 0,
    rules: [
      {
        id: "unit_offline",
        name: "Unit offline",
        description: "The unit stopped answering.",
        defaults: { enabled: true, forSec: 60 },
        fields: [],
        overrides: {},
      },
      {
        id: "gpu_temperature",
        name: "GPU temperature",
        description: "Hottest GPU.",
        defaults: { enabled: true, forSec: 120, warningC: 85, criticalC: 95 },
        fields: [
          { key: "warningC", label: "Warning", unit: "°C", min: 30, max: 120 },
          { key: "criticalC", label: "Critical", unit: "°C", min: 30, max: 120 },
        ],
        overrides: {},
      },
    ],
    channels: [
      {
        id: "ch_1",
        name: "Phone",
        type: "ntfy",
        url: MASKED,
        enabled: true,
        minSeverity: "warning",
        status: { lastSentAt: null, lastError: null, lastErrorAt: null },
      },
    ],
  };
}

const status: AlertsResponse = {
  enabled: true,
  active: [],
  pending: [],
  recent: [
    {
      id: 2,
      at: Date.now() - 60_000,
      status: "resolved",
      key: "unit_offline:spark-2",
      ruleId: "unit_offline",
      ruleName: "Unit offline",
      unitId: "spark-2",
      unitName: "spark-2",
      severity: "critical",
      summary: "Unreachable",
      value: null,
      startsAt: Date.now() - 600_000,
      endsAt: Date.now() - 60_000,
    },
  ],
};

type Call = { url: string; method: string; body: unknown };

function stubServer(opts: { test?: { ok: boolean; error?: string } } = {}) {
  const calls: Call[] = [];
  let config = baseConfig();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url, method, body });
      if (url === "/api/alerts/config" && method === "GET") return json(config);
      if (url === "/api/alerts/config" && method === "PUT") {
        config = {
          ...config,
          repeatIntervalMin: body.repeatIntervalMin,
          channels: body.channels.map((c: { id?: string; url: string }, i: number) => ({
            ...c,
            id: c.id ?? `ch_new${i}`,
            // The server masks whatever it stores.
            url: c.url.includes("…") ? c.url : `${new URL(c.url).origin}…${c.url.slice(-4)}`,
          })),
        };
        return json(config);
      }
      if (url === "/api/alerts") return json(status);
      if (url === "/api/alerts/test") return json(opts.test ?? { ok: true, status: 200 });
      if (url === "/api/settings") return json({ alertsEnabled: body.alertsEnabled });
      return json({ error: "unexpected" }, 500);
    })
  );
  return calls;
}

function dialog() {
  return document.querySelector<HTMLElement>('[role="dialog"]')!;
}

function button(label: string, root: ParentNode = dialog()) {
  return Array.from(root.querySelectorAll("button")).find((b) => b.textContent === label)!;
}

function setValue(el: HTMLInputElement | HTMLSelectElement, value: string) {
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")!.set!;
  act(() => {
    setter.call(el, value);
    el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
  });
}

async function openDialog(onSettingsSaved = vi.fn()) {
  render(<AlertsDialog open onClose={() => {}} onSettingsSaved={onSettingsSaved} />);
  await flush();
  await flush();
  return onSettingsSaved;
}

describe("AlertsDialog", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("shows the masked URL and sends it back unchanged when another field is edited", async () => {
    const calls = stubServer();
    await openDialog();
    const url = dialog().querySelector<HTMLInputElement>('input[aria-label="Channel URL"]')!;
    expect(url.value).toBe(MASKED);
    expect(dialog().textContent).toContain("Stored URL is hidden");
    expect(button("Save").disabled).toBe(true);

    setValue(dialog().querySelector<HTMLInputElement>('input[aria-label="Channel name"]')!, "Phone (Wei)");
    await act(async () => button("Save").click());
    await flush();

    const put = calls.find((c) => c.method === "PUT")!;
    expect(put.body).toMatchObject({
      channels: [{ id: "ch_1", name: "Phone (Wei)", type: "ntfy", url: MASKED, minSeverity: "warning" }],
    });
    expect(JSON.stringify(put.body)).not.toContain("status");
    expect(dialog().textContent).toContain("Saved");
  });

  it("adds, edits and removes channels, and only sends rule values that differ from defaults", async () => {
    const calls = stubServer();
    await openDialog();

    act(() => button("Add channel").click());
    const rows = () => dialog().querySelectorAll<HTMLElement>("[data-channel]");
    expect(rows().length).toBe(2);
    const added = rows()[1];
    setValue(added.querySelector<HTMLInputElement>('input[aria-label="Channel name"]')!, "Ops");
    setValue(added.querySelector<HTMLSelectElement>('select[aria-label="Channel type"]')!, "discord");
    setValue(added.querySelector<HTMLInputElement>('input[aria-label="Channel URL"]')!, "https://discord.com/api/webhooks/1/SECRET");
    setValue(added.querySelector<HTMLSelectElement>('select[aria-label="Minimum severity"]')!, "critical");
    setValue(dialog().querySelector<HTMLInputElement>('input[aria-label="GPU temperature Warning"]')!, "80");

    act(() => button("Remove", rows()[0]).click());
    expect(rows().length).toBe(1);

    await act(async () => button("Save").click());
    await flush();
    const put = calls.find((c) => c.method === "PUT")!.body as { channels: unknown[]; rules: unknown };
    expect(put.channels).toEqual([
      { name: "Ops", type: "discord", url: "https://discord.com/api/webhooks/1/SECRET", enabled: true, minSeverity: "critical" },
    ]);
    expect(put.rules).toEqual({ gpu_temperature: { warningC: 80 } });

    // After saving, the server's masked value replaces the secret on screen.
    const url = rows()[0].querySelector<HTMLInputElement>('input[aria-label="Channel URL"]')!;
    expect(url.value).toBe("https://discord.com…CRET");
  });

  it("Send test shows the result inline", async () => {
    const calls = stubServer({ test: { ok: false, error: "HTTP 404: topic not found" } });
    await openDialog();
    await act(async () => button("Send test").click());
    await flush();
    const test = calls.find((c) => c.url === "/api/alerts/test")!;
    expect(test.body).toMatchObject({ channelId: "ch_1", channel: { type: "ntfy", url: MASKED } });
    const result = dialog().querySelector('[data-channel="0"] [role="status"]')!;
    expect(result.textContent).toBe("HTTP 404: topic not found");
    expect(result.className).toContain("text-danger");
  });

  it("Send test reports success", async () => {
    stubServer();
    await openDialog();
    await act(async () => button("Send test").click());
    await flush();
    expect(dialog().querySelector('[data-channel="0"] [role="status"]')!.textContent).toBe("Sent");
  });

  it("the master switch saves alertsEnabled at once and lists recent events", async () => {
    const calls = stubServer();
    const onSaved = await openDialog();
    expect(dialog().textContent).toContain("Recent events");
    expect(dialog().textContent).toContain("spark-2");
    const master = dialog().querySelector<HTMLButtonElement>('[role="switch"][aria-label="Server alerts"]')!;
    expect(master.getAttribute("aria-checked")).toBe("true");
    await act(async () => master.click());
    await flush();
    expect(calls.find((c) => c.url === "/api/settings")?.body).toEqual({ alertsEnabled: false });
    expect(onSaved).toHaveBeenCalledWith({ alertsEnabled: false });
    expect(master.getAttribute("aria-checked")).toBe("false");
  });
});
