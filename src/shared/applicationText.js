/** Locale-neutral recognition of complete application-authored messages. Raw input is never rewritten. */
const vocabulary = [
  ["server.throttle.none","Clocks not limited"],
  ["server.throttle.flags1","HW thermal slowdown"],
  ["server.throttle.flags2","SW thermal slowdown"],
  ["server.throttle.flags3","HW thermal slowdown · SW thermal slowdown"],
  ["server.throttle.flags4","SW power cap"],
  ["server.throttle.flags5","HW thermal slowdown · SW power cap"],
  ["server.throttle.flags6","SW thermal slowdown · SW power cap"],
  ["server.throttle.flags7","HW thermal slowdown · SW thermal slowdown · SW power cap"],
  ["server.throttle.flags8","HW slowdown"],
  ["server.throttle.flags10","SW thermal slowdown · HW slowdown"],
  ["server.throttle.flags12","SW power cap · HW slowdown"],
  ["server.throttle.flags14","SW thermal slowdown · SW power cap · HW slowdown"],
  ["server.quality.keysStale","{correct}/{total} keys, {stale} stale"],
  ["server.quality.keys","{correct}/{total} keys"],
  ["server.quality.rules","{passed}/{total} rules"],
  ["server.quality.parsed","parsed {count}"],
  ["server.quality.noAnswer","no 'Answer:' line"],
  ["server.quality.unreadable","could not read the 'Answer:' line"],
  ["server.posture.badKey","Bad API key"],
  ["server.posture.authRequired","Auth required"],
  ["server.posture.keyed","API key · {scope}"],
  ["server.posture.open","Open · {scope}"],
  ["server.posture.rejected","Configured API key was rejected (401/403) · {scope} target ({host})."],
  ["server.posture.requiredDetail","API key required · {scope} target ({host}). Based on the configured probe host, not the process bind address."],
  ["server.posture.keyedDetail","Using configured API key · {scope} target ({host}). Based on the configured probe host, not the process bind address."],
  ["server.posture.openDetail","Unauthenticated · {scope} target ({host}). Based on the configured probe host, not the process bind address."],
  ["server.error.toolUnknown","Unknown benchmark type \"{type}\""],
  ["server.error.toolUnknownOption","Unknown option \"{option}\""],
  ["server.error.toolAbsolute","{label} must be an absolute path (or start with ~/)"],
  ["server.error.toolTraversal","{label} must not contain .."],
  ["server.error.toolText","{label} must be text"],
  ["server.error.toolUrl","{label} is not a valid URL"],
  ["server.error.toolUrlScheme","{label} must start with http:// or https://"],
  ["server.error.toolUrlCredentials","{label} must not contain credentials (use the API key field)"],
  ["server.error.toolLinkLocal","{label} points at a link-local address, which is not allowed"],
  ["server.error.toolLong","{label} is too long"],
  ["server.error.toolBool","{label} must be on or off"],
  ["server.error.toolWhole","{label} must be a whole number"],
  ["server.error.toolMin","{label} must be at least {min}"],
  ["server.error.toolMax","{label} must be at most {max}"],
  ["server.error.toolNumber","{label} must be a number"],
  ["server.error.toolChoice","{label} must be one of {choices}"],
  ["server.error.toolEmpty","{label} must not be empty"],
  ["server.error.toolSingleLine","{label} must be a single line"],
  ["server.error.toolFormat","{label} has an invalid format"],
  ["server.error.toolCharacter","{label} contains an invalid character"],
  ["server.error.toolBytes","{label} is longer than {max} KiB"],
  ["server.error.toolJsonObject","{label} must be a JSON object"],
  ["server.error.toolJson","{label} is not valid JSON"],
  ["server.error.toolList","{label} must be a non-empty list"],
  ["server.error.toolItems","{label} has too many items"],
  ["server.error.toolItem","{label} has an invalid item \"{item}\""],
  ["server.error.toolEntry","{label} has an invalid entry \"{entry}\""],
  ["server.error.toolUnsettable","{label} cannot be set"],
  ["server.error.toolPromptConflict","Use either the system prompt text or the system prompt file, not both"],
  ["server.error.toolContextConflict","Use either a single context pressure or a sweep, not both"],
  ["server.error.toolScenarioConflict","A short run and a specific scenario list cannot be combined"],
  ["server.error.toolExtraCount","Too many additional arguments"],
  ["server.error.toolExtraText","Additional arguments must be text"],
  ["server.error.toolExtraFlag","Additional argument \"{argument}\" is not a valid flag"],
  ["server.error.toolManaged","{argument} is controlled by sparkDash (or looks like it) and cannot be set here"],
  ["server.error.toolExtraDenied","Additional argument \"{argument}\" is not allowed"],
  ["server.error.toolExtraCharacters","Additional argument \"{argument}\" has unsupported characters"],
  ["server.error.toolExtraSecrets","Additional arguments must not carry secrets (use the API key field)"],
  ["server.error.toolKeyFormat","API key has an invalid format"],
  ["server.error.toolSavedKey","The saved API key can only be used with this Spark's own server; type a key to use another URL"],
  ["server.error.toolResultLarge","The result file is too large to load here."],
  ["server.error.toolResultMissing","No result file exists for this run (yet)."],
  ["server.error.toolOutputLarge","The output was too large to read"],
  ["server.error.toolNoAnswer","The Spark did not answer in time"],
  ["server.error.toolGithub","GitHub did not answer from the Spark."],
  ["server.error.toolWatchLimit","Stopped watching after the time limit. The run may still be going on the Spark."],
  ["server.error.toolStartExit","Could not reach the Spark or start the run (exit {code})."],
  ["server.error.toolConnectionLost","Lost the connection to the Spark before the run reported its result."],
  ["server.error.hermesRepairFailed","hermes is installed but cannot launch (broken install — the automatic repair could not fix it; reinstall hermes manually)."],
  ["server.error.hermesUpdateFailed","hermes update reported an error"],
  ["server.error.hostInput","Enter a host"],
  ["server.error.invalidUrl","Invalid URL"],
  ["server.error.sshpassMissing","sshpass is not installed. Install it with: sudo apt-get install sshpass"],
  ["server.error.invalidSparkId","Invalid Spark id: allowed characters are a-z A-Z 0-9 . _ -, length 1–64, and reserved names are not allowed"],
  ["server.error.dispatcherTimeout","dispatcher close timed out"],
  ["server.error.aborted","aborted"],
  ["server.error.timeout","timeout"],
  ["server.error.cpuCounters","invalid /proc/stat CPU counters"],
  ["server.error.remoteCpuCounters","invalid remote /proc/stat CPU counters"],
  ["server.error.windowsCpu","no CPU load from Win32_Processor"],
  ["server.error.historyFormat","unrecognised format"],
  ["server.error.jobNonce","invalid job nonce"],
  ["server.error.emptyKey","key file is empty"],
  ["server.error.shortCiphertext","ciphertext too short"],
  ["server.error.sshConfig","SSH config missing for {id}: host={host}, user={user}"],
  ["server.error.sshPassword","SSH password auth selected for {id} but no password is set (Edit Spark once — passwords are stored encrypted and survive restarts)"],
  ["server.error.resolveSshUser","Refusing to run as the dashboard user: cannot resolve SSH user {user} in the host passwd file. Set the Spark's SSH user."],
  ["server.error.switchUser","Cannot switch to user \"{user}\" (uid {uid}) from uid {current}; refusing to run as the wrong user."],
  ["server.error.hermesFetch","hermes update --check could not fetch from origin"],
  ["server.error.hermesCheckExit","hermes update --check exited {code} with no usable output"],
  ["server.error.hermesBroken","hermes is installed but cannot launch (broken install — usually a missing venv entry point). Run one-click Update Hermes to attempt an automatic repair."],
  ["server.error.hermesUnsupported","Installed hermes version does not support `hermes update --check` — update hermes manually once to enable monitoring."],
  ["server.error.connectionUnreachable","unreachable"],
  ["server.error.connectionTimeout","connection timed out"],
  ["server.error.connectionRefused","connection refused"],
  ["server.error.connectionRoute","no route to host"],
  ["server.error.connectionAuth","SSH authentication failed — check the key or user for this unit"],
  ["server.error.modelNotFound","Model not found"],
  ["server.error.authRequired","Authentication required"],
  ["server.error.invalidPort","Invalid port"],
  ["server.error.portUnconfigured","port is not configured for this Spark"],
  ["server.error.portRequired","port is required"],
  ["server.error.apiKeyRequired","apiKey is required (use \"\" to clear)"],
  ["server.error.hostRequiredFull","lanIp or ssh.host is required"],
  ["server.error.orderArray","body.order must be an array of spark ids"],
  ["server.error.orderArrayRegistry","order must be an array of spark ids"],
  ["server.error.windowsLauncher","Starting and stopping models from sparkDash is not supported on Windows PCs"],
  ["server.error.modelJobRunning","A job is running for this model. Cancel it first."],
  ["server.error.jobNotFound","Job not found (it may have been replaced by a newer one)"],
  ["server.error.comfyDisabled","ComfyUI monitoring is disabled for this Spark"],
  ["server.error.domains","Only 'storage' and 'llm' domains are supported"],
  ["server.error.hermesDisabled","Hermes Agent monitoring is disabled for this Spark (enable it in Edit Spark)"],
  ["server.error.primaryPort","Cannot remove the primary LLM port"],
  ["server.error.lastPort","Cannot remove the last LLM port"],
  ["server.error.workerApi","Worker nodes do not expose a local LLM API"],
  ["server.error.llmDisabled","LLM monitoring is disabled for this Spark"],
  ["server.error.showcaseRunning","A prompt showcase is already running for this Spark"],
  ["server.error.showcaseRunningManager","A showcase is already running for this Spark"],
  ["server.error.prefillRunning","A prefill benchmark is already running for this Spark"],
  ["server.error.decodeRunning","A decode benchmark is already running for this Spark"],
  ["server.error.qualityRunning","A quality benchmark is already running for this Spark"],
  ["server.error.benchRunning","A benchmark is already running for this Spark"],
  ["server.error.clearBenchRunning","Cannot clear history while a benchmark is running"],
  ["server.error.clearShowcaseRunning","Cannot clear history while a showcase is running"],
  ["server.error.benchNotFound","Benchmark not found"],
  ["server.error.showcaseNotFound","Showcase session not found"],
  ["server.error.categoryRequired","Select at least one category"],
  ["server.error.offlineSkipped","Offline — skipped"],
  ["server.error.wolUnsupported","DGX Spark does not support Wake-on-LAN"],
  ["server.error.wolUnsupportedNic","DGX Spark does not support Wake-on-LAN. The onboard NIC does not wake from a magic packet."],
  ["server.error.macMissing","No MAC address (enP7s7 not seen yet; set override in Edit Spark)"],
  ["server.error.macNotDetected","No MAC address yet. Wait until the node is online so enP7s7 can be detected, or set a MAC override in Edit Spark."],
  ["server.error.globalBenchCap","Global active benchmark cap reached; wait for a job to finish"],
  ["server.error.benchRate","Too many benchmark requests; try again shortly"],
  ["server.error.benchCooldown","Benchmark cooldown is active; wait before starting another job"],
  ["server.error.requestRate","Too many requests; try again shortly"],
  ["server.error.testRate","Too many test requests; try again shortly"],
  ["server.error.statusRate","Too many status requests; try again shortly"],
  ["server.error.launcherRate","Too many start/stop requests; try again shortly"],
  ["server.error.cancelRate","Too many cancellation requests; try again shortly"],
  ["server.error.directoryRequired","Directory is required"],
  ["server.error.directoryLong","Directory path is too long"],
  ["server.error.directoryAbsolute","Directory must be an absolute path (or start with ~/) using letters, digits and . _ - @ + = , /"],
  ["server.error.directoryTraversal","Directory must not contain .."],
  ["server.error.nameRequired","Name is required"],
  ["server.error.nameLong","Name is too long (80 characters max)"],
  ["server.error.launcherPort","Port must be 1-65535"],
  ["server.error.modelStillRunningRemove","This model is still running. Stop it first, then remove it."],
  ["server.error.modelStillRunningEdit","This model is still running. Stop it before changing its directory or scripts."],
  ["server.error.launcherStopTimeout","Stop script did not finish in time and was cancelled"],
  ["server.error.launcherWatcherTimeout","Stopped watching after 6 hours. The script keeps running; open the output again to re-attach."],
  ["server.error.launcherDisconnected","Connection to the Spark ended unexpectedly"],
  ["server.error.noQualityContext","Nothing to run — every selected long size exceeds the model context"],
  ["server.error.concurrencyRequired","Select at least one concurrency level (1, 2, 3, 4, 5, 6, 8, 10, 12, 16, 24, or 32)"],
  ["server.error.interruptedRestart","Interrupted — server restarted while the benchmark was running"],
  ["server.error.invalidSshUser","Invalid SSH user (allowed: letters, digits, . _ -)"],
  ["server.error.sshPort","SSH port must be an integer from 1 to 65535"],
  ["server.error.configId","Spark config must have an 'id'"],
  ["server.error.fromPort","fromPort must be an integer 1–65535"],
  ["server.error.toPort","toPort must be an integer 1–65535"],
  ["server.error.registryPersistence","Registry persistence failed"],
  ["server.error.secretsPersistence","Secrets persistence failed"],
  ["server.error.historyAge","olderThanMs must be a positive number"],
  ["server.error.historyConfirm","deleting all permanent history needs confirm=delete-all-history"],
  ["server.error.historyQuery","pass month=YYYY-MM, or all=true&confirm=delete-all-history"],
  ["server.error.runNotFound","Run not found"],
  ["server.error.toolRunning","Another Tool Eval Bench job is running on this Spark"],
  ["server.error.toolRunningWait","Another Tool Eval Bench job is running on this Spark. Wait for it or stop it first."],
  ["server.error.noInstall","No install is in progress"],
  ["server.error.resultRead","The stored result could not be read"],
  ["server.error.runStopDelete","Stop the run before deleting it."],
  ["server.error.runUnknown","Could not confirm the run has ended. Stop it, or delete again with force."],
  ["server.error.rootLauncher","Refusing to run launcher scripts as root; configure a non-root SSH user."],
  ["server.error.hermesSshUser","Invalid SSH user for Hermes (allowed: letters, digits, . _ -)"],
  ["server.error.hermesBinary","hermes binary not found on the machine"],
  ["server.error.emptyStream","Empty response body (streaming unsupported?)"],
  ["server.error.modelsUnreachable","OpenAI-compatible /v1/models unreachable"],
  ["server.error.slotsUnreachable","llama.cpp /slots unreachable"],
  ["server.error.allocatePort","Failed to allocate local port"],
  ["server.error.invalidTunnelPort","Invalid LLM port for SSH tunnel"],
  ["server.error.sshCommand","SSH command must be a non-empty string"],
  ["server.error.noFirstToken","No first token"],
  ["server.error.cancelled","Cancelled by user"],
  ["server.error.invalidLlmPort","Invalid LLM port"],
  ["server.error.sparkExists","Spark {id} already exists"],
  ["server.error.sparkMissingId","Spark {id} not found"],
  ["server.error.invalidTarget","Invalid or disallowed {field}: {target}"],
  ["server.error.sshHostDenied","SSH host not allowed: {host}"],
  ["server.error.sshUserDenied","SSH user not allowed: {user}"],
  ["server.error.targetAllowlist","Target {target} is not in the administrator allowlist"],
  ["server.error.targetResolve","Could not resolve allowed target {target}"],
  ["server.error.targetNoAddress","Allowed target {target} resolved to no addresses"],
  ["server.error.targetForbidden","Target {target} resolved to forbidden address {address}"],
  ["server.error.benchHostDenied","Remote benchmark host {host} is not allowlisted. Add it to SPARKDASH_BENCH_HOSTS or use a saved Spark LLM target."],
  ["server.error.decodeBudget","Decode benchmark exceeds the {limit}-token work budget"],
  ["server.error.prefillBudget","Prefill benchmark exceeds the {limit}-token work budget"],
  ["server.error.maxTokens","maxTokens must be between {min} and {max}"],
  ["server.error.temperature","temperature must be between {min} and {max}"],
  ["server.error.contextRequired","Select at least one context size ({range} tokens)"],
  ["server.error.categoriesRequired","Select at least one category ({categories})"],
  ["server.error.promptsArray","prompts must be an array of {count} strings (each {length} chars)"],
  ["server.error.launcherLimit","At most {count} models per Spark"],
  ["server.error.launcherWindows","LLM launcher is not supported on Windows units ({id})"],
  ["server.error.scriptName","{label} must be a file name ending in .sh, like start.sh (letters, digits, . _ -)"],
  ["server.error.launcherConflict","Another job is running on this Spark ({action} {launcher}). Wait for it or cancel it first."],
  ["server.error.macInvalid","Invalid MAC address: {mac}"],
  ["server.error.wolFailed","WoL send failed: {detail}"],
  ["server.error.sparkUnreachable","Spark unreachable: {detail}"],
  ["server.error.sshTunnelStart","SSH tunnel failed to start: {detail}"],
  ["server.error.sshTunnelReady","SSH tunnel did not become ready on {target}"],
  ["server.error.llmTunnel","LLM on {host} is not reachable over the LAN, and SSH tunnel to 127.0.0.1:{port} failed: {detail}"],
  ["server.error.sshConnect","SSH to {target} failed: {detail}"],
  ["server.error.http","HTTP {status}: {detail}"],
  ["server.error.prefillSkipped","Skipped: {size} plus template and reply does not fit the model context ({tokens} tokens)"],
  ["server.progress.warming","Warming up…"],
  ["server.progress.warmingTunnel","Warming up via SSH tunnel…"],
  ["server.progress.calibrating","Calibrating…"],
  ["server.progress.concurrency","Running concurrency {count}…"],
  ["server.progress.prefillingRun","Prefilling {size} (run {run}/{total})…"],
  ["server.progress.prefilling","Prefilling {size}…"],
  ["server.progress.tunnel","Opening SSH tunnel to 127.0.0.1:{port}…"],
  ["server.progress.reaching","Reaching LLM on {target}…"],
  ["server.progress.qualityQa","QA…"],
  ["server.progress.qualityReason","Reasoning…"],
  ["server.progress.qualityArith","Arithmetic chain…"],
  ["server.progress.qualityTrack","State tracking…"],
  ["server.progress.qualityGsm8k","GSM8K…"],
  ["server.progress.qualityMmlu","MMLU…"],
  ["server.progress.qualityFollow","Instruction following…"],
  ["server.progress.qualityLong","Long-context recall…"],
  ["server.progress.qualityLongSize","Long-context recall {size}…"],
  ["server.connection.notRun","Check did not run"],
  ["server.connection.hostReadable","Host metrics are readable"],
  ["server.connection.windowsNoGpu","SSH works, but no GPU data came back from this Windows PC. For an NVIDIA GPU, install the driver and make sure nvidia-smi.exe runs; an AMD iGPU needs Windows' GPU performance counters."],
  ["server.connection.hermesMissing","Hermes Agent not found"],
  ["server.connection.keyExpired","Tailscale key expired"],
  ["server.connection.online","Online"],
  ["server.connection.notOnline","Not online"],
  ["server.connection.installed","Installed"],
  ["server.connection.installedVersion","Installed ({version})"],
  ["server.connection.authRequired","Auth required (set API key in LLM Settings)"],
  ["server.connection.model","Model: {model}"],
  ["server.connection.reachable","reachable"],
  ["server.connection.ok","ok"],
  ["server.connection.comfyVersion","ComfyUI {version}"],
  ["server.connection.http","HTTP {status}"],
  ["server.error.sparkNotFound","Spark not found"],
  ["server.error.remoteTokenRequired","Remote access requires SPARKDASH_TOKEN"],
  ["server.error.restartUnsupported","Restart is only available when sparkDash runs in Docker with restart: always"],
  ["server.error.hostRequired","lanIp or ssh.host required"],
  ["server.error.passwordRequired","password is required"],
  ["server.error.promptIdRequired","promptId is required"],
  ["server.error.disabledDevicesArray","disabledDevices must be an array"],
  ["server.error.disabledInterfacesArray","disabledInterfaces must be an array"],
  ["server.error.llmPortsArray","llmPorts must be an array"],
  ["server.error.llmPortsValid","llmPorts must contain at least one valid port 1–65535"],
  ["server.error.llmPortValid","llmPort must be an integer 1–65535"],
  ["server.error.portValid","port must be an integer 1–65535"],
  ["server.message.shutdownInitiated","Shutdown initiated"],
  ["server.connection.disabled","Disabled"],
  ["server.connection.available","Available"],
  ["server.connection.unavailable","Unavailable"],
  ["server.connection.label.host.local","Local collectors"],
  ["server.connection.label.host.remote","Remote SSH"],
  ["server.connection.label.llm","LLM API"],
  ["server.connection.label.comfy","ComfyUI"],
  ["server.connection.label.hermes","Hermes Agent"],
  ["server.connection.label.tailnet","Tailnet"],
  ["server.connection.recovery.host","Check the host connection and collector permissions."],
  ["server.connection.recovery.llm","Start the LLM API on the configured port or disable LLM monitoring."],
  ["server.connection.recovery.comfy","Start ComfyUI on the configured port or disable ComfyUI monitoring."],
  ["server.connection.recovery.hermes","Install or repair Hermes Agent, or disable Hermes monitoring."],
  ["server.connection.recovery.tailnet","Start Tailscale, sign in this unit, or disable Tailnet monitoring."],
  ["server.progress.starting","Starting…"],
  ["server.progress.connecting","Connecting to LLM…"],
  ["server.progress.readingModels","Reading /v1/models…"],
  ["server.progress.cancelling","Cancelling…"],
  ["server.progress.interrupted","Interrupted"],
  ["server.progress.failed","Failed"],
  ["server.progress.cancelled","Cancelled"],
  ["server.progress.done","Done"]
];
// This is a recognition budget, not a diagnostic limit: callers retain the raw
// string when recognition declines. Count UTF-16 code units, like String.length.
export const APPLICATION_TEXT_MAX_LENGTH = 4096;
const exact = new Map();
const patterns = [];
for (const [key, template] of vocabulary) {
  const names = [...template.matchAll(/\{(\w+)\}/g)].map(m => m[1]);
  if (!names.length) exact.set(template, { key });
  else {
    patterns.push({ key, names, pieces: template.split(/\{\w+\}/g) });
  }
}
export function applicationTextI18n(raw) {
  if (typeof raw !== 'string' || raw.length > APPLICATION_TEXT_MAX_LENGTH) return undefined;
  const known = exact.get(raw);
  if (known) return known;
  for (const { key, names, pieces } of patterns) {
    const captures = matchTemplate(raw, pieces);
    if (captures) return { key, params: Object.fromEntries(names.map((name, i) => [name, captures[i]])) };
  }
  return undefined;
}

/** Literal searches only; each non-empty placeholder keeps the earliest feasible capture. */
function matchTemplate(raw, pieces) {
  const count = pieces.length - 1;
  if (!raw.startsWith(pieces[0]) || !raw.endsWith(pieces[count])) return undefined;
  const suffixStart = raw.length - pieces[count].length;
  const latest = [];
  let boundary = suffixStart;
  // Reverse bounds prove that the remaining literals and non-empty captures can
  // fit. Forward matching can then select the first separator without backtracking,
  // including when a parameter itself contains a separator.
  for (let i = count - 1; i > 0; i--) {
    const maxStart = boundary - pieces[i].length - 1;
    if (maxStart < 0) return undefined;
    const position = raw.lastIndexOf(pieces[i], maxStart);
    if (position < 0) return undefined;
    latest[i] = position;
    boundary = position;
  }
  const captures = [];
  let cursor = pieces[0].length;
  for (let i = 1; i < count; i++) {
    const position = raw.indexOf(pieces[i], cursor + 1);
    if (position < 0 || position > latest[i]) return undefined;
    captures.push(raw.slice(cursor, position));
    cursor = position + pieces[i].length;
  }
  if (cursor >= suffixStart) return undefined;
  captures.push(raw.slice(cursor, suffixStart));
  return captures;
}

// Required values for the finite browser templates; partial metadata falls back safely.
const requiredParams = {
  "server.action.start": [],
  "server.action.stop": [],
  "server.action.attach": [],
  "health.xid.title.critical": [],
  "health.oom.title.critical": [],
  "health.link-speed.primaryInterface": [],
  "health.thermal.title.warn": [],
  "health.thermal.title.critical": [],
  "health.memory.title.warn": [],
  "health.memory.title.critical": [],
  "health.low-power.title.warn": [],
  "health.concurrency.title.warn": [],
  "health.link-speed.title.warn": [],
  "health.roce-link.title.critical": [
    "count"
  ],
  "health.roce-loss.title.warn": [],
  "health.thermal.detail": [
    "temperature",
    "warn",
    "critical"
  ],
  "health.thermal.hint": [],
  "health.low-power.detail": [
    "utilisation",
    "watts",
    "samples"
  ],
  "health.low-power.hint": [],
  "health.memory.detail": [
    "available",
    "total"
  ],
  "health.memory.hint": [],
  "health.xid.detail": [
    "count"
  ],
  "health.xid.latest": [
    "last"
  ],
  "health.xid.hint": [],
  "health.oom.detail": [
    "count"
  ],
  "health.oom.hint": [],
  "health.concurrency.detail": [
    "count",
    "memory"
  ],
  "health.concurrency.hint": [],
  "health.link-speed.detail": [
    "interface",
    "mbps"
  ],
  "health.link-speed.hint": [],
  "health.roce-link.detail": [
    "links"
  ],
  "health.roce-link.hint": [],
  "health.roce-loss.detail": [
    "links"
  ],
  "health.roce-loss.hint": [],
  "server.action.startScript": [],
  "server.action.stopScript": [],
  "server.throttle.none": [],
  "server.throttle.flags1": [],
  "server.throttle.flags2": [],
  "server.throttle.flags3": [],
  "server.throttle.flags4": [],
  "server.throttle.flags5": [],
  "server.throttle.flags6": [],
  "server.throttle.flags7": [],
  "server.throttle.flags8": [],
  "server.throttle.flags10": [],
  "server.throttle.flags12": [],
  "server.throttle.flags14": [],
  "server.quality.keysStale": [
    "correct",
    "total",
    "stale"
  ],
  "server.quality.keys": [
    "correct",
    "total"
  ],
  "server.quality.rules": [
    "passed",
    "total"
  ],
  "server.quality.parsed": [
    "count"
  ],
  "server.quality.noAnswer": [],
  "server.quality.unreadable": [],
  "server.posture.badKey": [],
  "server.posture.authRequired": [],
  "server.posture.keyed": [
    "scope"
  ],
  "server.posture.open": [
    "scope"
  ],
  "server.posture.rejected": [
    "scope",
    "host"
  ],
  "server.posture.requiredDetail": [
    "scope",
    "host"
  ],
  "server.posture.keyedDetail": [
    "scope",
    "host"
  ],
  "server.posture.openDetail": [
    "scope",
    "host"
  ],
  "server.error.toolUnknown": [
    "type"
  ],
  "server.error.toolUnknownOption": [
    "option"
  ],
  "server.error.toolAbsolute": [
    "label"
  ],
  "server.error.toolTraversal": [
    "label"
  ],
  "server.error.toolText": [
    "label"
  ],
  "server.error.toolUrl": [
    "label"
  ],
  "server.error.toolUrlScheme": [
    "label"
  ],
  "server.error.toolUrlCredentials": [
    "label"
  ],
  "server.error.toolLinkLocal": [
    "label"
  ],
  "server.error.toolLong": [
    "label"
  ],
  "server.error.toolBool": [
    "label"
  ],
  "server.error.toolWhole": [
    "label"
  ],
  "server.error.toolMin": [
    "label",
    "min"
  ],
  "server.error.toolMax": [
    "label",
    "max"
  ],
  "server.error.toolNumber": [
    "label"
  ],
  "server.error.toolChoice": [
    "label",
    "choices"
  ],
  "server.error.toolEmpty": [
    "label"
  ],
  "server.error.toolSingleLine": [
    "label"
  ],
  "server.error.toolFormat": [
    "label"
  ],
  "server.error.toolCharacter": [
    "label"
  ],
  "server.error.toolBytes": [
    "label",
    "max"
  ],
  "server.error.toolJsonObject": [
    "label"
  ],
  "server.error.toolJson": [
    "label"
  ],
  "server.error.toolList": [
    "label"
  ],
  "server.error.toolItems": [
    "label"
  ],
  "server.error.toolItem": [
    "label",
    "item"
  ],
  "server.error.toolEntry": [
    "label",
    "entry"
  ],
  "server.error.toolUnsettable": [
    "label"
  ],
  "server.error.toolPromptConflict": [],
  "server.error.toolContextConflict": [],
  "server.error.toolScenarioConflict": [],
  "server.error.toolExtraCount": [],
  "server.error.toolExtraText": [],
  "server.error.toolExtraFlag": [
    "argument"
  ],
  "server.error.toolManaged": [
    "argument"
  ],
  "server.error.toolExtraDenied": [
    "argument"
  ],
  "server.error.toolExtraCharacters": [
    "argument"
  ],
  "server.error.toolExtraSecrets": [],
  "server.error.toolKeyFormat": [],
  "server.error.toolSavedKey": [],
  "server.error.toolResultLarge": [],
  "server.error.toolResultMissing": [],
  "server.error.toolOutputLarge": [],
  "server.error.toolNoAnswer": [],
  "server.error.toolGithub": [],
  "server.error.toolWatchLimit": [],
  "server.error.toolStartExit": [
    "code"
  ],
  "server.error.toolConnectionLost": [],
  "server.error.hermesRepairFailed": [],
  "server.error.hermesUpdateFailed": [],
  "server.error.hostInput": [],
  "server.error.invalidUrl": [],
  "server.error.sshpassMissing": [],
  "server.error.invalidSparkId": [],
  "server.error.dispatcherTimeout": [],
  "server.error.aborted": [],
  "server.error.timeout": [],
  "server.error.cpuCounters": [],
  "server.error.remoteCpuCounters": [],
  "server.error.windowsCpu": [],
  "server.error.historyFormat": [],
  "server.error.jobNonce": [],
  "server.error.emptyKey": [],
  "server.error.shortCiphertext": [],
  "server.error.sshConfig": [
    "id",
    "host",
    "user"
  ],
  "server.error.sshPassword": [
    "id"
  ],
  "server.error.resolveSshUser": [
    "user"
  ],
  "server.error.switchUser": [
    "user",
    "uid",
    "current"
  ],
  "server.error.hermesFetch": [],
  "server.error.hermesCheckExit": [
    "code"
  ],
  "server.error.hermesBroken": [],
  "server.error.hermesUnsupported": [],
  "server.error.connectionUnreachable": [],
  "server.error.connectionTimeout": [],
  "server.error.connectionRefused": [],
  "server.error.connectionRoute": [],
  "server.error.connectionAuth": [],
  "server.error.sparkNotFound": [],
  "server.error.remoteTokenRequired": [],
  "server.error.restartUnsupported": [],
  "server.error.hostRequired": [],
  "server.error.passwordRequired": [],
  "server.error.promptIdRequired": [],
  "server.error.disabledDevicesArray": [],
  "server.error.disabledInterfacesArray": [],
  "server.error.llmPortsArray": [],
  "server.error.llmPortsValid": [],
  "server.error.llmPortValid": [],
  "server.error.portValid": [],
  "server.error.unexpected": [
    "detail"
  ],
  "server.message.shutdownInitiated": [],
  "server.message.wakeSent": [
    "mac",
    "broadcast"
  ],
  "server.connection.disabled": [],
  "server.connection.available": [],
  "server.connection.unavailable": [],
  "server.connection.raw": [
    "detail"
  ],
  "server.connection.label.host.local": [],
  "server.connection.label.host.remote": [],
  "server.connection.label.llm": [],
  "server.connection.label.comfy": [],
  "server.connection.label.hermes": [],
  "server.connection.label.tailnet": [],
  "server.connection.recovery.host": [],
  "server.connection.recovery.hostLocal": [],
  "server.connection.recovery.hostRemote": [],
  "server.connection.recovery.llm": [],
  "server.connection.recovery.comfy": [],
  "server.connection.recovery.hermes": [],
  "server.connection.recovery.tailnet": [],
  "server.job.error": [
    "detail"
  ],
  "server.job.status.running": [
    "action",
    "launcher"
  ],
  "server.job.status.completed": [
    "action",
    "launcher"
  ],
  "server.job.status.cancelled": [
    "action",
    "launcher"
  ],
  "server.job.status.detached": [
    "launcher"
  ],
  "server.progress.starting": [],
  "server.progress.connecting": [],
  "server.progress.readingModels": [],
  "server.progress.cancelling": [],
  "server.progress.interrupted": [],
  "server.progress.failed": [],
  "server.progress.cancelled": [],
  "server.progress.done": [],
  "server.progress.running": [
    "detail"
  ],
  "server.error.cancelled": [],
  "server.error.invalidLlmPort": [],
  "server.error.modelNotFound": [],
  "server.error.authRequired": [],
  "server.error.invalidPort": [],
  "server.error.portUnconfigured": [],
  "server.error.portRequired": [],
  "server.error.apiKeyRequired": [],
  "server.error.hostRequiredFull": [],
  "server.error.orderArray": [],
  "server.error.orderArrayRegistry": [],
  "server.error.windowsLauncher": [],
  "server.error.modelJobRunning": [],
  "server.error.jobNotFound": [],
  "server.error.comfyDisabled": [],
  "server.error.domains": [],
  "server.error.hermesDisabled": [],
  "server.error.primaryPort": [],
  "server.error.lastPort": [],
  "server.error.workerApi": [],
  "server.error.llmDisabled": [],
  "server.error.showcaseRunning": [],
  "server.error.showcaseRunningManager": [],
  "server.error.prefillRunning": [],
  "server.error.decodeRunning": [],
  "server.error.qualityRunning": [],
  "server.error.benchRunning": [],
  "server.error.clearBenchRunning": [],
  "server.error.clearShowcaseRunning": [],
  "server.error.benchNotFound": [],
  "server.error.showcaseNotFound": [],
  "server.error.categoryRequired": [],
  "server.error.offlineSkipped": [],
  "server.error.wolUnsupported": [],
  "server.error.wolUnsupportedNic": [],
  "server.error.macMissing": [],
  "server.error.macNotDetected": [],
  "server.error.globalBenchCap": [],
  "server.error.benchRate": [],
  "server.error.benchCooldown": [],
  "server.error.requestRate": [],
  "server.error.testRate": [],
  "server.error.statusRate": [],
  "server.error.launcherRate": [],
  "server.error.cancelRate": [],
  "server.error.directoryRequired": [],
  "server.error.directoryLong": [],
  "server.error.directoryAbsolute": [],
  "server.error.directoryTraversal": [],
  "server.error.nameRequired": [],
  "server.error.nameLong": [],
  "server.error.launcherPort": [],
  "server.error.modelStillRunningRemove": [],
  "server.error.modelStillRunningEdit": [],
  "server.error.launcherStopTimeout": [],
  "server.error.launcherWatcherTimeout": [],
  "server.error.launcherDisconnected": [],
  "server.error.noQualityContext": [],
  "server.error.concurrencyRequired": [],
  "server.error.interruptedRestart": [],
  "server.error.invalidSshUser": [],
  "server.error.sshPort": [],
  "server.error.configId": [],
  "server.error.fromPort": [],
  "server.error.toPort": [],
  "server.error.registryPersistence": [],
  "server.error.secretsPersistence": [],
  "server.error.historyAge": [],
  "server.error.historyConfirm": [],
  "server.error.historyQuery": [],
  "server.error.runNotFound": [],
  "server.error.toolRunning": [],
  "server.error.toolRunningWait": [],
  "server.error.noInstall": [],
  "server.error.resultRead": [],
  "server.error.runStopDelete": [],
  "server.error.runUnknown": [],
  "server.error.rootLauncher": [],
  "server.error.hermesSshUser": [],
  "server.error.hermesBinary": [],
  "server.error.emptyStream": [],
  "server.error.modelsUnreachable": [],
  "server.error.slotsUnreachable": [],
  "server.error.allocatePort": [],
  "server.error.invalidTunnelPort": [],
  "server.error.sshCommand": [],
  "server.error.noFirstToken": [],
  "server.error.sparkExists": [
    "id"
  ],
  "server.error.sparkMissingId": [
    "id"
  ],
  "server.error.invalidTarget": [
    "field",
    "target"
  ],
  "server.error.sshHostDenied": [
    "host"
  ],
  "server.error.sshUserDenied": [
    "user"
  ],
  "server.error.targetAllowlist": [
    "target"
  ],
  "server.error.targetResolve": [
    "target"
  ],
  "server.error.targetNoAddress": [
    "target"
  ],
  "server.error.targetForbidden": [
    "target",
    "address"
  ],
  "server.error.benchHostDenied": [
    "host"
  ],
  "server.error.decodeBudget": [
    "limit"
  ],
  "server.error.prefillBudget": [
    "limit"
  ],
  "server.error.maxTokens": [
    "min",
    "max"
  ],
  "server.error.temperature": [
    "min",
    "max"
  ],
  "server.error.contextRequired": [
    "range"
  ],
  "server.error.categoriesRequired": [
    "categories"
  ],
  "server.error.promptsArray": [
    "count",
    "length"
  ],
  "server.error.launcherLimit": [
    "count"
  ],
  "server.error.launcherWindows": [
    "id"
  ],
  "server.error.scriptName": [
    "label"
  ],
  "server.error.launcherConflict": [
    "action",
    "launcher"
  ],
  "server.error.macInvalid": [
    "mac"
  ],
  "server.error.wolFailed": [
    "detail"
  ],
  "server.error.sparkUnreachable": [
    "detail"
  ],
  "server.error.sshTunnelStart": [
    "detail"
  ],
  "server.error.sshTunnelReady": [
    "target"
  ],
  "server.error.llmTunnel": [
    "host",
    "port",
    "detail"
  ],
  "server.error.sshConnect": [
    "target",
    "detail"
  ],
  "server.error.http": [
    "status",
    "detail"
  ],
  "server.error.prefillSkipped": [
    "size",
    "tokens"
  ],
  "server.progress.warming": [],
  "server.progress.warmingTunnel": [],
  "server.progress.calibrating": [],
  "server.progress.concurrency": [
    "count"
  ],
  "server.progress.prefillingRun": [
    "size",
    "run",
    "total"
  ],
  "server.progress.prefilling": [
    "size"
  ],
  "server.progress.tunnel": [
    "port"
  ],
  "server.progress.reaching": [
    "target"
  ],
  "server.progress.qualityQa": [],
  "server.progress.qualityReason": [],
  "server.progress.qualityArith": [],
  "server.progress.qualityTrack": [],
  "server.progress.qualityGsm8k": [],
  "server.progress.qualityMmlu": [],
  "server.progress.qualityFollow": [],
  "server.progress.qualityLong": [],
  "server.progress.qualityLongSize": [
    "size"
  ],
  "server.connection.notRun": [],
  "server.connection.hostReadable": [],
  "server.connection.windowsNoGpu": [],
  "server.connection.hermesMissing": [],
  "server.connection.keyExpired": [],
  "server.connection.online": [],
  "server.connection.notOnline": [],
  "server.connection.installed": [],
  "server.connection.installedVersion": [
    "version"
  ],
  "server.connection.authRequired": [],
  "server.connection.model": [
    "model"
  ],
  "server.connection.reachable": [],
  "server.connection.ok": [],
  "server.connection.comfyVersion": [
    "version"
  ],
  "server.connection.http": [
    "status"
  ],
  "server.field.defaultUrl": [],
  "server.scope.local": [],
  "server.scope.loopback": [],
  "server.scope.publicLabel": [],
  "server.scope.public": [],
  "server.scope.host": [],
  "server.scope.unknown": []
};
export function applicationTextRequiredParams(key) { return requiredParams[key]; }
