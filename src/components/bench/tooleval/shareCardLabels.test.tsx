import { act } from "react";
import { afterEach, expect, it } from "vitest";
import { setLocale } from "../../../i18n";
import { render } from "../../../testing/render";
import { useShareCardLabels } from "./shareCardLabels";

function Labels() {
  const labels = useShareCardLabels();
  return <span>{labels.completed} / {labels.toolEvalComparison}</span>;
}

afterEach(async () => { await act(async () => { await setLocale("en"); }); });

it("loads share-card resources and updates the next card labels on language change", async () => {
  await setLocale("en");
  const view = render(<Labels />);
  expect(view.container.textContent).toBe("COMPLETED / Tool Eval Comparison");
  await act(async () => { await setLocale("zh-CN"); });
  expect(view.container.textContent).not.toContain("COMPLETED");
  expect(view.container.textContent).not.toContain("completed");
  expect(view.container.textContent).toMatch(/[\u4e00-\u9fff]/);
});
