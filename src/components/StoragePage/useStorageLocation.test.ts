import { describe, expect, it } from "vitest";
import { buildSearch, parseSearch } from "./useStorageLocation";

describe("storage address", () => {
  it("round-trips spark, tab and folder, including awkward folder names", () => {
    const loc = { spark: "spark 1", tab: "docker" as const, path: "/home/me/My Files/a&b=c" };
    expect(parseSearch(buildSearch(loc))).toEqual(loc);
  });

  it("leaves out what is not set", () => {
    expect(buildSearch({ spark: null, tab: null, path: null })).toBe("");
    expect(buildSearch({ spark: null, tab: "files", path: null })).toBe("?tab=files");
  });

  it("ignores values that cannot be right", () => {
    expect(parseSearch("?tab=other&path=relative/path&spark=")).toEqual({ spark: null, tab: null, path: null });
  });
});
