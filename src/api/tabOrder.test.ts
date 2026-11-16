import { describe, expect, it } from "vitest";
import { mergeTabOrderKeepingHidden } from "./tabOrder";

const all = ["a", "w1", "b", "w2", "c"].map((id) => ({ id }));
const hidden = new Set(["w1", "w2"]);

describe("mergeTabOrderKeepingHidden", () => {
  it("keeps hidden workers in their slots when only visible ids are reordered", () => {
    expect(mergeTabOrderKeepingHidden(all, ["c", "b", "a"], hidden)).toEqual(["c", "w1", "b", "w2", "a"]);
  });

  it("uses a full-list order from the sidebar as dropped, workers included", () => {
    expect(mergeTabOrderKeepingHidden(all, ["c", "a", "w1", "b", "w2"], hidden)).toEqual(["c", "a", "w1", "b", "w2"]);
    expect(mergeTabOrderKeepingHidden(all, ["w2", "a", "w1", "b", "c"], hidden)).toEqual(["w2", "a", "w1", "b", "c"]);
  });
});
