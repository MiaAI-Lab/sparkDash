import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { SystemCollector } from "../SystemCollector.js";

function localSpark() {
  return {
    id: "local-test",
    name: "Local Test",
    isLocal: true,
    lanIp: "127.0.0.1",
  };
}

test("host network file fallback reads container proc without recursing", async (t) => {
  const collector = new SystemCollector(localSpark());
  collector._hasHostProc = () => false;
  const reads = [];
  t.mock.method(fs, "readFileSync", (filePath, encoding) => {
    reads.push({ filePath, encoding });
    return "Inter-| Receive | Transmit\n";
  });

  const contents = await collector._readHostNetFile("dev");

  assert.match(contents, /Inter-\|/);
  assert.deepEqual(reads, [{ filePath: "/proc/net/dev", encoding: "utf-8" }]);
});
