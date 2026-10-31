import { expect, it } from "vitest";
import { renderServerMessage } from "./serverMessages";

const t = (key: string) => key;

it("renders finite server descriptors and leaves unknown diagnostics unchanged", () => {
  expect(renderServerMessage(t, { key: "server.error.sparkNotFound" }, "Spark not found")).toBe("error.sparkNotFound");
  expect(renderServerMessage(t, undefined, "raw\noutput")).toBe("raw\noutput");
  expect(renderServerMessage(t, { key: "external.error" }, "external output")).toBe("external output");
});
