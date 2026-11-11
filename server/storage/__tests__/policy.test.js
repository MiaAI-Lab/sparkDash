import { test } from "node:test";
import { strict as assert } from "node:assert";
import { assertDeletable, depthOf, hasUnsafeName, parentOf, parseAbsolutePath, protectedReason } from "../policy.js";

test("parseAbsolutePath accepts clean absolute paths and rejects everything that could change meaning", () => {
  assert.equal(parseAbsolutePath("/"), "/");
  assert.equal(parseAbsolutePath("/home/me/My Files/a b.txt"), "/home/me/My Files/a b.txt");
  for (const bad of [
    undefined, null, 42, "", "relative/path", "~/x", "/a/../etc", "/a/./b", "/a//b", "/a/b/", "/a\nb", "/a\u0000b", "/a\tb",
    "/bad�name", `/${"x".repeat(5000)}`, "..", "/..",
  ]) {
    assert.throws(() => parseAbsolutePath(bad), (e) => e.status === 400 && e.code === "bad-path", JSON.stringify(bad)?.slice(0, 40));
  }
});

test("system locations, the whole disk and ssh keys are protected", () => {
  for (const p of [
    "/", "/home", "/usr", "/var", "/etc", "/etc/ssh/sshd_config", "/boot/efi", "/bin/ls", "/usr/bin/python3", "/usr/lib/x86_64-linux-gnu",
    "/var/lib/docker", "/var/lib/docker/overlay2/abc", "/var/lib/dpkg/status", "/proc/1", "/sys/kernel", "/dev/null", "/run/user/1000",
    "/home/zurih", "/usr/local", "/var/log", "/home/zurih/.ssh", "/home/zurih/.ssh/authorized_keys", "/root/.ssh", "/data/projects/.ssh/id_rsa",
  ]) {
    assert.ok(protectedReason(p), `${p} should be protected`);
    assert.throws(() => assertDeletable(p), (e) => e.status === 403 && e.code === "protected", p);
  }
});

test("ordinary data, caches and logs can be deleted", () => {
  for (const p of [
    "/home/zurih/models/llama", "/home/zurih/.cache/huggingface", "/tmp/claude-1000", "/var/log/syslog.1", "/var/cache/apt/archives/x.deb",
    "/opt/nvidia/old", "/usr/local/cuda-12.1", "/mnt/data/dataset", "/srv/www/site", "/usr/share/doc/foo", "/var/lib/apt/lists",
  ]) {
    assert.equal(protectedReason(p), null, p);
    assert.doesNotThrow(() => assertDeletable(p));
  }
});

test("a lookalike prefix is not mistaken for a protected folder", () => {
  assert.equal(protectedReason("/etcetera/x"), null);
  assert.equal(protectedReason("/var/lib/dockerfiles"), null);
  assert.equal(protectedReason("/home/zurih/not.ssh/key"), null);
  assert.equal(protectedReason("/home/zurih/.sshx"), null);
});

test("unusual names cannot be deleted from here", () => {
  assert.equal(hasUnsafeName("/a/b"), false);
  assert.equal(hasUnsafeName("/a/new\nline"), true);
  assert.equal(hasUnsafeName("/a/�"), true);
  assert.match(protectedReason("/home/zurih/new\nline"), /unusual characters/);
});

test("parentOf and depthOf", () => {
  assert.equal(parentOf("/"), null);
  assert.equal(parentOf("/a"), "/");
  assert.equal(parentOf("/a/b"), "/a");
  assert.equal(depthOf("/"), 0);
  assert.equal(depthOf("/a"), 1);
  assert.equal(depthOf("/a/b/c"), 3);
});
