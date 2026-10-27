/**
 * Shell programs for the Qwen ⇄ Ollama memory-floor mode switcher: Qwen's stop.sh
 * (attached — its exit code gates the switch), Qwen's start.sh (spawned detached by
 * the manager with output appended to the memory-mode log; the script's exit alone
 * never counts, the container state is verified instead), and the docker CLI calls
 * (inspect / start / stop) that check the real state of each stack.
 *
 * Everything that reaches a shell is a server-owned constant — the Qwen directory
 * and the container names come from the environment (config.js), never from a
 * request body — and is checked against the launcher allow-lists
 * (llmlaunch/validate.js) before it is embedded in single quotes. The whole program
 * ships base64-encoded, exactly like server/llmlaunch/commands.js, so no quoting
 * difference between shells can alter it.
 */
import { validateContainerName, validateDir, validateScriptName } from "../llmlaunch/validate.js";

export const QWEN_START_SCRIPT = "start.sh";
export const QWEN_STOP_SCRIPT = "stop.sh";

function wrap(program) {
  const b64 = Buffer.from(program, "utf8").toString("base64");
  return `bash -c "$(printf %s '${b64}' | base64 -d)"`;
}

function dirExpr(dir) {
  return dir.startsWith("~/") ? `"$HOME"/'${dir.slice(2)}'` : `'${dir}'`;
}

function assertDir(dir) {
  const err = validateDir(dir);
  if (err) throw new Error(err);
}

function assertScript(name, label) {
  const err = validateScriptName(name, label);
  if (err) throw new Error(err);
}

function assertContainer(name) {
  const err = validateContainerName(name);
  if (err) throw new Error(err);
}

/** `docker inspect -f '{{.State.Status}}' <name>` — the manager maps failure to "missing". */
export function buildContainerStateCommand(name) {
  assertContainer(name);
  return wrap(`docker inspect -f '{{.State.Status}}' -- '${name}'`);
}

export function buildDockerStartCommand(name) {
  assertContainer(name);
  return wrap(`docker start '${name}'`);
}

export function buildDockerStopCommand(name) {
  assertContainer(name);
  return wrap(`docker stop '${name}'`);
}

/**
 * Qwen's stop.sh, run attached: the caller keeps the exit code and the output, and
 * a non-zero exit aborts the switch ("Qwen left running; Ollama NOT started").
 */
export function buildQwenStopCommand({ dir, script = QWEN_STOP_SCRIPT }) {
  assertDir(dir);
  assertScript(script, "Stop script");
  const program = [
    `cd ${dirExpr(dir)} || { echo "[memory-mode] cannot open ${dir}"; exit 127; }`,
    `if [ -x './${script}' ]; then './${script}'; else bash './${script}'; fi`,
  ].join("\n");
  return wrap(program);
}

/**
 * Qwen's start.sh. The manager spawns this detached with stdout/stderr appended to
 * the memory-mode log; whether the container came up is verified separately against
 * `docker inspect`, so this program says nothing about success.
 */
export function buildQwenStartCommand({ dir, script = QWEN_START_SCRIPT }) {
  assertDir(dir);
  assertScript(script, "Start script");
  const program = [
    `cd ${dirExpr(dir)} || { echo "[memory-mode] cannot open ${dir}"; exit 127; }`,
    `echo "[memory-mode] starting ${dir}/${script} as $(id -un)"`,
    `if [ -x './${script}' ]; then './${script}'; else bash './${script}'; fi`,
  ].join("\n");
  return wrap(program);
}
