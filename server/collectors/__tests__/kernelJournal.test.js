import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { KernelJournal, KERNEL_JOURNAL_PAGE_SIZE, kernelJournalCommand } from "../kernelJournal.js";

const boot = "bbcdd1fdecf34ccb9c894ecb6efbc6af";
const otherBoot = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const cursor = (n) => `s=abc;i=${n};b=${boot}`;
function page(messages, n, id = boot) {
  return [id, ...messages.map((MESSAGE) => JSON.stringify({ MESSAGE, _BOOT_ID: id })), `-- cursor: ${cursor(n)}`].join("\n");
}

test("backfill stays unknown until the final page and resumes without double counting", async () => {
  // Given a boot journal larger than a page.
  let now = 100;
  const commands = [];
  const outputs = [page(Array(KERNEL_JOURNAL_PAGE_SIZE).fill("NV_ERR_NO_MEMORY"), 1), page(["NVRM: Xid (PCI:0000:01:00): 79", "oom-kill: test"], 2)];
  const journal = new KernelJournal(async (cmd) => { commands.push(cmd); return outputs.shift(); }, 60_000, () => now);
  assert.equal(await journal.read(), null);
  now += 10_000;
  // When the next bounded page completes the baseline.
  const value = await journal.read();
  // Then counts cover both pages once and the command resumes from the saved cursor.
  assert.deepEqual(value, { nvErr: KERNEL_JOURNAL_PAGE_SIZE, xid: 1, oomKills: 1, lastXid: "Xid 79" });
  assert.ok(commands[1].includes(`--after-cursor='${cursor(1)}'`));
  assert.deepEqual(await journal.read(), value);
  assert.equal(commands.length, 2);
});

test("new records increment counters after the configured scan interval", async () => {
  // Given a complete baseline.
  let now = 100;
  const outputs = [page(["NV_ERR_NO_MEMORY"], 1), page(["NV_ERR_NO_MEMORY", "Out of memory: Killed process 123"], 2)];
  const journal = new KernelJournal(async () => outputs.shift(), 60_000, () => now);
  await journal.read();
  now += 60_000;
  // When new records arrive.
  const value = await journal.read();
  // Then only their delta is added.
  assert.deepEqual(value, { nvErr: 2, xid: 0, oomKills: 1, lastXid: null });
});

test("a failed or truncated scan retains its cursor and retries after backoff", async (t) => {
  // Given a valid baseline followed by truncated JSON.
  t.mock.method(console, "warn", () => {});
  let now = 100;
  const commands = [];
  const outputs = [page(["NV_ERR_NO_MEMORY"], 1), boot + '\n{"MESSAGE":', page(["oom-kill: test"], 2)];
  const journal = new KernelJournal(async (cmd) => { commands.push(cmd); return outputs.shift(); }, 60_000, () => now);
  const baseline = await journal.read();
  now += 60_000;
  // When an incomplete scan fails and is retried later.
  assert.deepEqual(await journal.read(), baseline);
  assert.deepEqual(await journal.read(), baseline);
  assert.equal(commands.length, 2);
  now += 60_000;
  const value = await journal.read();
  // Then neither the failed page nor the baseline was counted twice.
  assert.deepEqual(value, { nvErr: 1, xid: 0, oomKills: 1, lastXid: null });
  assert.ok(commands[2].includes(`--after-cursor='${cursor(1)}'`));
});

test("a changed boot resets the cursor and error totals", async () => {
  // Given cached counters from an older boot.
  let now = 100;
  const outputs = [page(["NV_ERR_NO_MEMORY"], 1), page(["oom-kill: new boot"], 2, otherBoot)];
  const journal = new KernelJournal(async () => outputs.shift(), 60_000, () => now);
  await journal.read();
  now += 60_000;
  // When the host has rebooted.
  const value = await journal.read();
  // Then old-boot counters are discarded.
  assert.deepEqual(value, { nvErr: 0, xid: 0, oomKills: 1, lastXid: null });
});

test("host-side timeout kills a stuck journal command and its children", { skip: process.platform !== "linux" }, async (t) => {
  // Given a journalctl stand-in with a child that ignores graceful termination.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sparkdash-journal-test-"));
  const pidFile = path.join(dir, "child.pid");
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, "journalctl"), '#!/bin/sh\ntrap "" TERM\nsleep 30 &\nprintf "%s" "$!" > "$JOURNAL_TEST_PID_FILE"\nwait\n', { mode: 0o700 });
  // When the real shell/timeout path exceeds its deadline.
  await assert.rejects(promisify(execFile)("sh", ["-c", kernelJournalCommand(null, null, 0.2)], {
    timeout: 5000,
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, JOURNAL_TEST_PID_FILE: pidFile },
  }));
  // Then no child remains running after the command has returned.
  const pid = (await fs.readFile(pidFile, "utf8")).trim();
  try {
    const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8");
    assert.equal(stat.split(") ")[1][0], "Z", `journal child ${pid} is still running`);
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
});

test("a kernel message of raw bytes is consumed, not re-read forever", async () => {
  // journalctl JSON renders a field holding non-UTF8 or non-printable bytes as an array of byte
  // values — a driver logging a hex dump is enough. Rejecting the page would leave the cursor
  // unadvanced, so the same page would be re-read on every poll and all three counters would
  // stay frozen at their last value while new Xids went uncounted.
  let now = 100;
  const commands = [];
  const binary = [0x6e, 0x76, 0x72, 0x6d, 0x00, 0xff, 0xfe];
  const mixed = [
    boot,
    JSON.stringify({ MESSAGE: "NV_ERR_NO_MEMORY", _BOOT_ID: boot }),
    JSON.stringify({ MESSAGE: binary, _BOOT_ID: boot }),
    JSON.stringify({ MESSAGE: "NVRM: Xid (PCI:0000:01:00): 79", _BOOT_ID: boot }),
    `-- cursor: ${cursor(1)}`,
  ].join("\n");
  const outputs = [mixed, page(["NV_ERR_NO_MEMORY"], 2)];
  const journal = new KernelJournal(
    async (cmd) => {
      commands.push(cmd);
      return outputs.shift();
    },
    60_000,
    () => now
  );

  // The page completes: the readable records around the binary one are counted.
  assert.deepEqual(await journal.read(), { nvErr: 1, xid: 1, oomKills: 0, lastXid: "Xid 79" });

  // And the cursor advanced, so the next read resumes past it and new records are counted.
  now += 60_000;
  assert.deepEqual(await journal.read(), { nvErr: 2, xid: 1, oomKills: 0, lastXid: "Xid 79" });
  assert.ok(commands[1].includes(`--after-cursor='${cursor(1)}'`), commands[1]);
});

test("a page is small enough to stay inside the command output buffer", () => {
  // A page that overflows the 10 MB buffer the local and SSH runners allow fails, leaves the
  // cursor unadvanced, and fails identically on every retry, so the baseline never completes.
  // Kernel messages can reach ~2 KB.
  assert.ok(KERNEL_JOURNAL_PAGE_SIZE * 2048 < 10 * 1024 * 1024, `page of ${KERNEL_JOURNAL_PAGE_SIZE} can overflow`);
});
