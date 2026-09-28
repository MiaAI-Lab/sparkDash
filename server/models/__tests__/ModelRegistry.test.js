import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { ModelRegistry, validateModelConfig, resolveRepoDir, isValidModelId, normalizeRepoUrl } from "../ModelRegistry.js";

const BASE = "/cluster/docker";

function tmpFile(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `models-${name}-`));
  return path.join(dir, "models.json");
}

const VALID = {
  id: "glm",
  name: "GLM",
  dir: "glm-repo",
  startScript: "start.sh",
  stopScript: "stop.sh",
  container: "glm-head",
  port: 8000,
};

// ─── Path allowlist ────────────────────────────────────────
test("resolveRepoDir accepts a base-relative dir and blocks traversal", () => {
  assert.equal(resolveRepoDir("glm-repo", BASE), path.join(BASE, "glm-repo"));
  assert.equal(resolveRepoDir("../etc", BASE), null);
  assert.equal(resolveRepoDir("../../etc/passwd", BASE), null);
  assert.equal(resolveRepoDir("/etc/passwd", BASE), null); // absolute outside base
  assert.equal(resolveRepoDir("", BASE), null);
  assert.equal(resolveRepoDir("./.ssh", BASE), null); // hidden segment
});

test("validateModelConfig enforces the script / container / port allowlists", () => {
  assert.doesNotThrow(() => validateModelConfig(VALID, BASE));
  assert.throws(() => validateModelConfig({ ...VALID, dir: "../../etc" }, BASE), /inside/);
  assert.throws(() => validateModelConfig({ ...VALID, startScript: "start; rm -rf /" }, BASE), /startScript/);
  assert.throws(() => validateModelConfig({ ...VALID, container: "a b" }, BASE), /container/);
  assert.throws(() => validateModelConfig({ ...VALID, port: 70000 }, BASE), /port/);
  assert.throws(() => validateModelConfig({ ...VALID, container: null, port: null }, BASE), /container \/ port/);
  assert.throws(() => validateModelConfig({ ...VALID, id: "jobs" }, BASE), /Invalid model id/);
});

test("sparkId: optional, allowlisted, and trimmed into storage", () => {
  assert.equal(validateModelConfig(VALID, BASE).sparkId, null);
  assert.equal(validateModelConfig({ ...VALID, sparkId: "" }, BASE).sparkId, null);
  assert.equal(validateModelConfig({ ...VALID, sparkId: " spark1-lan " }, BASE).sparkId, "spark1-lan");
  assert.throws(() => validateModelConfig({ ...VALID, sparkId: "../etc" }, BASE), /sparkId/);
  assert.throws(() => validateModelConfig({ ...VALID, sparkId: "spark 1" }, BASE), /sparkId/);
  assert.throws(() => validateModelConfig({ ...VALID, sparkId: 42 }, BASE), /sparkId/);
});

test("startArgs are restricted to single flag tokens", () => {
  // A valueless flag and a --flag=value are both fine.
  assert.doesNotThrow(() => validateModelConfig({ ...VALID, startArgs: ["--host", "--port=8000"] }, BASE));
  // A flag with an embedded command substitution must be rejected.
  assert.throws(
    () => validateModelConfig({ ...VALID, startArgs: ["--x=$(whoami)"] }, BASE),
    /startArgs/
  );
  assert.throws(() => validateModelConfig({ ...VALID, startArgs: ["; rm -rf /"] }, BASE), /startArgs/);
});

test("isValidModelId rejects reserved route segments", () => {
  assert.ok(isValidModelId("glm-53"));
  for (const r of ["jobs", "config", "preview", "order", "..", ""]) assert.equal(isValidModelId(r), false);
});

// ─── repoUrl (card link) ───────────────────────────────────
test("normalizeRepoUrl accepts https and scp-style remotes, rejects the rest", () => {
  assert.equal(normalizeRepoUrl("https://github.com/o/r.git"), "https://github.com/o/r");
  assert.equal(normalizeRepoUrl("https://github.com/o/r/"), "https://github.com/o/r");
  assert.equal(normalizeRepoUrl("git@github.com:o/r.git"), "https://github.com/o/r");
  assert.equal(normalizeRepoUrl("ssh://git@github.com/o/r"), "https://github.com/o/r");
  for (const bad of ["javascript:alert(1)", "file:///etc/passwd", "", null, 42]) {
    assert.equal(normalizeRepoUrl(bad), null);
  }
});

test("validateModelConfig normalizes repoUrl through the same https gate", () => {
  assert.equal(
    validateModelConfig({ ...VALID, repoUrl: "git@github.com:MiaAI-Lab/r.git" }, BASE).repoUrl,
    "https://github.com/MiaAI-Lab/r"
  );
  // Junk never persists — it just disappears (optional metadata, not an error).
  assert.equal(validateModelConfig({ ...VALID, repoUrl: "javascript:alert(1)" }, BASE).repoUrl, null);
});

// ─── CRUD + persistence ────────────────────────────────────
test("registry add/update/remove round-trips through disk and emits events", () => {
  const file = tmpFile("crud");
  const reg = new ModelRegistry(file, BASE);
  const events = [];
  reg.onChange((action, m) => events.push(`${action}:${m.id}`));

  reg.addModel(VALID);
  assert.equal(reg.models.length, 1);
  assert.ok(fs.existsSync(file));

  reg.updateModel("glm", { name: "GLM renamed" });
  assert.equal(reg.getModel("glm").name, "GLM renamed");

  assert.throws(() => reg.addModel(VALID), /already exists/);

  const removed = reg.removeModel("glm");
  assert.equal(removed.id, "glm");
  assert.equal(reg.models.length, 0);
  assert.deepEqual(events, ["add:glm", "update:glm", "remove:glm"]);
});

test("a reload re-validates and skips one bad entry without hiding the rest", () => {
  const file = tmpFile("reload");
  fs.writeFileSync(
    file,
    JSON.stringify({
      models: [
        VALID,
        { id: "bad", dir: "../../etc", startScript: "start.sh", stopScript: "stop.sh", container: "x" },
      ],
    })
  );
  const reg = new ModelRegistry(file, BASE);
  assert.deepEqual(reg.modelIds, ["glm"]); // bad entry dropped, good one kept
});

// ─── Card ordering (position) ──────────────────────────────
test("positions are stamped 1..n in list order and survive a reload", () => {
  const file = tmpFile("order");
  const reg = new ModelRegistry(file, BASE);
  for (const id of ["a", "b", "c"]) reg.addModel({ ...VALID, id, container: `${id}-c` });
  assert.deepEqual(
    reg.models.map((m) => [m.id, m.position]),
    [["a", 1], ["b", 2], ["c", 3]]
  );
  // Persisted numbers match the in-memory order after a restart.
  const again = new ModelRegistry(file, BASE);
  assert.deepEqual(again.modelIds, ["a", "b", "c"]);
  assert.deepEqual(again.models.map((m) => m.position), [1, 2, 3]);
});

test("moveModel swaps neighbours, clamps at the ends and renumbers", () => {
  const reg = new ModelRegistry(tmpFile("move"), BASE);
  for (const id of ["a", "b", "c"]) reg.addModel({ ...VALID, id, container: `${id}-c` });

  let list = reg.moveModel("c", -1); // c up one → a c b
  assert.deepEqual(list.map((m) => m.id), ["a", "c", "b"]);
  assert.deepEqual(list.map((m) => m.position), [1, 2, 3]);

  list = reg.moveModel("c", -1); // → c a b
  assert.deepEqual(list.map((m) => m.id), ["c", "a", "b"]);

  list = reg.moveModel("c", -1); // already first: no-op, no throw
  assert.deepEqual(list.map((m) => m.id), ["c", "a", "b"]);

  list = reg.moveModel("b", 1); // already last: no-op
  assert.deepEqual(list.map((m) => m.id), ["c", "a", "b"]);
  assert.throws(() => reg.moveModel("nope", 1), /not found/);
});

test("a hand-written position wins over array order and is renumbered", () => {
  const file = tmpFile("handorder");
  // qwen listed last in the array but asked to be first — deepseek second.
  fs.writeFileSync(
    file,
    JSON.stringify({
      models: [
        { ...VALID, id: "glm", container: "g", position: 3 },
        { ...VALID, id: "qwen", container: "q", position: 1 },
        { ...VALID, id: "ds", container: "d", position: 2 },
      ],
    })
  );
  const reg = new ModelRegistry(file, BASE);
  assert.deepEqual(reg.modelIds, ["qwen", "ds", "glm"]);

  // setOrder rewrites everything; unlisted ids fall to the back in old order.
  reg.setOrder(["glm", "qwen"]);
  assert.deepEqual(reg.modelIds, ["glm", "qwen", "ds"]);
  assert.deepEqual(reg.models.map((m) => m.position), [1, 2, 3]);

  // Position is validated, not trusted.
  assert.throws(() => validateModelConfig({ ...VALID, position: 0 }, BASE), /position/);
  assert.throws(() => validateModelConfig({ ...VALID, position: -2 }, BASE), /position/);
  assert.throws(() => validateModelConfig({ ...VALID, position: "1.5" }, BASE), /position/);
  // Removing a model closes the gap so numbering stays 1..n.
  reg.removeModel("qwen");
  assert.deepEqual(reg.models.map((m) => [m.id, m.position]), [["glm", 1], ["ds", 2]]);
});

// ─── Schedule conflict guard ───────────────────────────────
test("two models with overlapping windows cannot both be enabled", () => {
  const file = tmpFile("conflict");
  const reg = new ModelRegistry(file, BASE);
  reg.addModel({
    ...VALID,
    schedule: { enabled: true, weekday: [{ start: "18:00", end: "08:00" }], weekend: [] },
  });
  // A second model claiming 06:00 (inside 18:00→08:00) must be rejected 409.
  let status = null;
  try {
    reg.addModel({
      ...VALID,
      id: "qwen",
      name: "Qwen",
      dir: "qwen-repo",
      schedule: { enabled: true, weekday: [{ start: "06:00", end: "09:00" }], weekend: [] },
    });
  } catch (e) {
    status = e.status;
    assert.match(e.message, /overlaps/);
  }
  assert.equal(status, 409);
  assert.equal(reg.modelIds.length, 1); // second model never persisted
});

test("a disabled schedule is exempt from the conflict check", () => {
  const file = tmpFile("disabled");
  const reg = new ModelRegistry(file, BASE);
  const win = { enabled: false, weekday: [{ start: "18:00", end: "08:00" }], weekend: [] };
  reg.addModel({ ...VALID, schedule: win });
  // Same window but disabled → allowed (only one is active).
  reg.addModel({ ...VALID, id: "qwen", name: "Qwen", dir: "qwen-repo", schedule: win });
  assert.equal(reg.modelIds.length, 2);
});
