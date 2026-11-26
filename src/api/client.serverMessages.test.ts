import { afterEach, expect, it, vi } from "vitest";
import { ApiError, fetchSparks } from "./client";

afterEach(() => vi.unstubAllGlobals());

it("preserves existing API error fields while exposing its optional descriptor", async () => {
  const body = { error: "Spark not found", code: "not-found", partial: true, i18n: { error: { key: "server.error.sparkNotFound" } } };
  vi.stubGlobal("fetch", vi.fn(async () => Response.json(body, { status: 404 })));
  const request = fetchSparks();
  await expect(request).rejects.toBeInstanceOf(ApiError);
  await expect(request).rejects.toMatchObject({
    message: "Spark not found",
    status: 404,
    code: "not-found",
    partial: true,
    i18n: body.i18n,
  });
});

it("keeps an unrecognized raw diagnostic exactly intact", async () => {
  const raw = "ssh command output\nnon-standard diagnostic";
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: raw }), { status: 500, headers: { "Content-Type": "application/json" } })));
  await expect(fetchSparks()).rejects.toMatchObject({ message: raw, i18n: undefined });
});
