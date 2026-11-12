import { describe, expect, it } from "vitest";
import { tabAfterKey, tabForSection } from "./settingsTabs";

describe("settings tabs", () => {
  it("opens the named tab, or General", () => {
    expect(tabForSection("energy")).toBe("energy");
    expect(tabForSection("security")).toBe("security");
    expect(tabForSection(null)).toBe("general");
    expect(tabForSection("nope")).toBe("general");
  });

  it("moves with arrows (wrapping), Home and End, and ignores other keys", () => {
    expect(tabAfterKey("general", "ArrowRight")).toBe("overview");
    expect(tabAfterKey("security", "ArrowRight")).toBe("general");
    expect(tabAfterKey("general", "ArrowLeft")).toBe("security");
    expect(tabAfterKey("sparks", "Home")).toBe("general");
    expect(tabAfterKey("sparks", "End")).toBe("security");
    expect(tabAfterKey("sparks", "Enter")).toBeNull();
  });
});