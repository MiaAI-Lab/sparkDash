// Modified by Maxrio9, 2026: training page route regression.
import { afterEach, describe, expect, it, vi } from "vitest";
import { benchId, benchTypeOf, ENERGY_ID, idToPath, initialActiveId, isPageId, isStaleSparkId, KIOSK_ID, OVERVIEW_ID, pathToId, STORAGE_ID, TRAINING_ID, TEMPS_ID } from "./constants";

describe("route helpers", () => {
  it("round-trips ids and paths", () => {
    expect(pathToId("/energy")).toBe(ENERGY_ID);
    expect(pathToId("/temps")).toBe(TEMPS_ID);
    expect(idToPath(TEMPS_ID)).toBe("/temps");
    expect(pathToId("/storage")).toBe(STORAGE_ID);
    expect(idToPath(STORAGE_ID)).toBe("/storage");
    expect(isPageId(STORAGE_ID)).toBe(true);
    expect(pathToId("/training")).toBe(TRAINING_ID);
    expect(idToPath(TRAINING_ID)).toBe("/training");
    expect(isPageId(TRAINING_ID)).toBe(true);
    expect(pathToId("/spark/a%20b")).toBe("a b");
    expect(idToPath("a b")).toBe("/spark/a%20b");
    expect(pathToId(idToPath(benchId("decode")))).toBe(benchId("decode"));
    expect(pathToId("/showcase/x")).toBeNull();
    expect(idToPath(KIOSK_ID)).toBe("/kiosk");
    expect(pathToId("/kiosk/")).toBe(KIOSK_ID);
    expect(pathToId("/nothing-here")).toBe(OVERVIEW_ID);
  });

  describe("initialActiveId", () => {
    afterEach(() => vi.unstubAllGlobals());
    it("reads the deep link synchronously, so /energy never starts on the Overview", () => {
      vi.stubGlobal("location", { pathname: "/energy" });
      expect(initialActiveId()).toBe(ENERGY_ID);
      vi.stubGlobal("location", { pathname: "/spark/alpha" });
      expect(initialActiveId()).toBe("alpha");
    });
    it("falls back to the Overview for showcase paths or a missing pathname", () => {
      vi.stubGlobal("location", { pathname: "/showcase/alpha" });
      expect(initialActiveId()).toBe(OVERVIEW_ID);
      vi.stubGlobal("location", {});
      expect(initialActiveId()).toBe(OVERVIEW_ID);
    });
  });

  describe("isStaleSparkId", () => {
    it("flags a Spark that left the fleet, once the fleet is known", () => {
      expect(isStaleSparkId("gone", ["a", "b"], true)).toBe(true);
      expect(isStaleSparkId("a", ["a", "b"], true)).toBe(false);
    });
    it("never flags pages, the Overview, or anything before the first fleet list", () => {
      expect(isStaleSparkId(ENERGY_ID, [], true)).toBe(false);
      expect(isStaleSparkId(benchId("decode"), [], true)).toBe(false);
      expect(isStaleSparkId(OVERVIEW_ID, [], true)).toBe(false);
      expect(isStaleSparkId(null, [], true)).toBe(false);
      expect(isStaleSparkId("gone", [], false)).toBe(false);
    });
  });
});

// The internal page id cannot collide with an existing valid physical-unit id.
it("keeps a physical __training__ unit separate from the optional training page", () => {
  expect(isPageId("__training__")).toBe(false);
  expect(idToPath("__training__")).toBe("/spark/__training__");
  expect(pathToId("/spark/__training__")).toBe("__training__");
  expect(pathToId("/training")).toBe(TRAINING_ID);
});
