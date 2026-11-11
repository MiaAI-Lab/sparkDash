import { test } from "node:test";
import { strict as assert } from "node:assert";
import fs from "node:fs";
import { isSystemMount, mainFilesystem, metricsView, statusView } from "../../../src/shared/mainFilesystem.js";

// The same layouts the browser tests use (src/shared/mainFilesystem.test.tsx): one policy, one fixture.
const { layouts } = JSON.parse(fs.readFileSync(new URL("../../../src/shared/mainFilesystem.fixtures.json", import.meta.url), "utf8"));
const MiB = 1024 * 1024;

test("the server imports the shared main-disk policy and reads every fixture layout the same way as the page", () => {
  assert.ok(layouts.length >= 6);
  for (const { name, rows, expected } of layouts) {
    // As the Storage Manager's status program reports them, and as a unit snapshot carries them.
    const status = rows.map((r) => ({ source: `/dev/${r.device}`, fstype: "ext4", mount: r.mount, totalBytes: r.totalBytes, usedBytes: 0, availBytes: r.totalBytes }));
    const metrics = rows.map((r) => ({ device: r.device, label: r.mount, total: Math.round(r.totalBytes / MiB) }));
    const a = mainFilesystem(status, statusView);
    const b = mainFilesystem(metrics, metricsView);
    if (expected == null) {
      assert.equal(a, null, name);
      assert.equal(b, null, name);
      continue;
    }
    assert.deepEqual([a?.source, a?.mount], [`/dev/${expected.device}`, expected.mount], name);
    assert.deepEqual([b?.device, b?.label], [expected.device, expected.mount], name);
  }
});

test("system mounts and unusable rows never qualify", () => {
  for (const m of ["/boot", "/boot/efi", "/efi", "/snap/core/1", "/var/snap/lxd/common", null, 5]) assert.equal(isSystemMount(m), true, String(m));
  for (const m of ["/", "/home", "/bootcamp", "/data/boot"]) assert.equal(isSystemMount(m), false, m);
  const v = (x) => x;
  assert.equal(mainFilesystem([{ mount: "C:", totalBytes: 5 }, { mount: "/x", totalBytes: 0 }, { mount: "/y", totalBytes: Number.NaN }], v), null);
  assert.equal(mainFilesystem(undefined, v), null);
});
