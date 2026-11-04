import { afterEach, expect, it } from "vitest";
import { i18n, setLocale } from "../../i18n";
import { energyRangeLabel, energyRangeLong } from "./EnergyPage";

afterEach(async () => { await setLocale("en"); });

it("uses localized segment labels and long range labels for energy", async () => {
  await setLocale("zh-CN");
  const t = i18n.getFixedT("zh-CN", "statistics");
  expect(energyRangeLabel(t, "7d")).toBe("7 天");
  expect(energyRangeLong(t, "7d")).toBe("最近 7 天");
});
