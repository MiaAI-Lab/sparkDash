import { afterEach, expect, it, vi } from "vitest";
import { fetchSparks } from "./client";
import { ApiRequestError } from "./types";

afterEach(() => vi.unstubAllGlobals());

it("preserves the English API error while exposing its optional descriptor", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "Spark not found", i18n: { error: { key: "server.error.sparkNotFound" } } }), { status: 404, headers: { "Content-Type": "application/json" } })));
  await expect(fetchSparks()).rejects.toMatchObject({
    name: "ApiRequestError",
    message: "Spark not found",
    i18n: { error: { key: "server.error.sparkNotFound" } },
  } satisfies Partial<ApiRequestError>);
});

it("keeps an unrecognized raw diagnostic exactly intact", async () => {
  const raw = "ssh command output\nnon-standard diagnostic";
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: raw }), { status: 500, headers: { "Content-Type": "application/json" } })));
  await expect(fetchSparks()).rejects.toMatchObject({ message: raw, i18n: undefined });
});
