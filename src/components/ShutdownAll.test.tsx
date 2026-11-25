import { act } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SparkSnapshot } from "../api/types";
import { setLocale } from "../i18n";
import { flush, render } from "../testing/render";
import { ShutdownAll } from "./ShutdownAll";

function spark(id: string, name: string): SparkSnapshot {
  return { id, name, kind: "spark", online: true } as unknown as SparkSnapshot;
}

function jsonResponse(payload: unknown) {
  return { ok: true, status: 200, json: async () => payload };
}

/** Open the dialog, type the confirm phrase, acknowledge and submit. */
async function confirmShutdown() {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(() =>
    [...document.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.trim() === "Shut down all")!
      .click()
  );
  await flush();
  const phrase = document.querySelector<HTMLInputElement>(".field-input--mono")!;
  await act(() => {
    setter.call(phrase, "poweroff");
    phrase.dispatchEvent(new Event("input", { bubbles: true }));
    document.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click();
  });
  await act(() => document.querySelector<HTMLButtonElement>(".modal-sheet__footer .btn--danger")!.click());
  await flush();
}

beforeEach(async () => {
  await setLocale("en");
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await act(() => setLocale("en"));
});

it("names each unit and its reason when a batch shutdown fails", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      jsonResponse({
        success: true,
        results: [
          { id: "spark-one", ok: false, error: "missing /usr/local/bin/spark-shutdown" },
          { id: "spark-two", ok: false, error: "passwordless sudo required for /usr/local/bin/spark-shutdown" },
        ],
      })
    )
  );
  render(<ShutdownAll sparks={[spark("spark-one", "SparkOne"), spark("spark-two", "SparkTwo")]} />);
  await confirmShutdown();

  const msg = document.querySelector(".ov-batchmsg")!;
  expect(msg.className).toContain("is-err");
  expect(msg.textContent).toContain("0 shut down");
  expect(msg.textContent).toContain("2 failed");
  expect(msg.textContent).toContain("SparkOne: missing /usr/local/bin/spark-shutdown");
  expect(msg.textContent).toContain("SparkTwo: passwordless sudo required");
  // Hover title carries the full list.
  expect(msg.getAttribute("title")).toContain("SparkTwo: passwordless sudo required");
});

it("collapses a long failure list into the first reasons plus a counted remainder", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      jsonResponse({
        success: true,
        results: ["a", "b", "c", "d"].map((id) => ({ id, ok: false, error: `no route to ${id}` })),
      })
    )
  );
  render(
    <ShutdownAll
      sparks={[spark("a", "A"), spark("b", "B"), spark("c", "C"), spark("d", "D")]}
    />
  );
  await confirmShutdown();

  const msg = document.querySelector(".ov-batchmsg")!;
  expect(msg.textContent).toContain("A: no route to a");
  expect(msg.textContent).toContain("C: no route to c");
  expect(msg.textContent).not.toContain("D: no route to d");
  expect(msg.textContent).toContain("+1 more");
});

it("keeps skipped offline units out of the failure details", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      jsonResponse({
        success: true,
        results: [
          { id: "spark-one", ok: false, skipped: true, error: "Offline — skipped" },
          { id: "spark-two", ok: true },
        ],
      })
    )
  );
  render(<ShutdownAll sparks={[spark("spark-one", "SparkOne"), spark("spark-two", "SparkTwo")]} />);
  await confirmShutdown();

  const msg = document.querySelector(".ov-batchmsg")!;
  expect(msg.className).toContain("is-ok");
  expect(msg.textContent).toContain("1 shut down");
  expect(msg.textContent).toContain("1 skipped");
  expect(msg.textContent).not.toContain("Offline");
});

it("leaves the all-clear message unchanged", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      jsonResponse({
        success: true,
        results: [
          { id: "spark-one", ok: true },
          { id: "spark-two", ok: true },
        ],
      })
    )
  );
  render(<ShutdownAll sparks={[spark("spark-one", "SparkOne"), spark("spark-two", "SparkTwo")]} />);
  await confirmShutdown();

  const msg = document.querySelector(".ov-batchmsg")!;
  expect(msg.className).toContain("is-ok");
  expect(msg.textContent).toBe("2 shut down");
});
