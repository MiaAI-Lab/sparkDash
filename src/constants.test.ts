import { describe, expect, it } from "vitest";
import {
  ACTIVITY_ID,
  ENERGY_ID,
  OVERVIEW_ID,
  TOKENS_ID,
  idToPath,
  isPageId,
  pathToId,
  benchId,
  benchTypeOf,
} from "./constants";

describe("page routing ids", () => {
  it("maps every page id to a path and back", () => {
    for (const id of [OVERVIEW_ID, TOKENS_ID, ENERGY_ID, ACTIVITY_ID, benchId("tool-eval"), "spark-1"]) {
      expect(pathToId(idToPath(id))).toBe(id);
    }
    expect(idToPath(TOKENS_ID)).toBe("/tokens");
    expect(idToPath(benchId("spec-decode"))).toBe("/bench/spec-decode");
    expect(idToPath(null)).toBe("/");
  });

  it("treats unknown paths as the overview and leaves showcase to its own route", () => {
    expect(pathToId("/")).toBe(OVERVIEW_ID);
    expect(pathToId("/nonsense")).toBe(OVERVIEW_ID);
    expect(pathToId("/showcase/x")).toBeNull();
    expect(pathToId("/tokens/")).toBe(TOKENS_ID);
  });

  it("knows which ids are pages and extracts the benchmark type", () => {
    expect(isPageId(TOKENS_ID)).toBe(true);
    expect(isPageId(benchId("decode"))).toBe(true);
    expect(isPageId("spark-1")).toBe(false);
    expect(isPageId(null)).toBe(false);
    expect(benchTypeOf(benchId("quality"))).toBe("quality");
    expect(benchTypeOf("spark-1")).toBeNull();
  });
});
