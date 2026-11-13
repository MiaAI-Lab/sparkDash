/**
 * WINDOWS-ARM64-PORT — PowerShell equivalents of the POSIX shell programs the
 * dashboard ships to a Spark.
 *
 * Upstream sparkDash expresses every on-Spark program as bash (base64-wrapped),
 * correct for a remote Linux/Mac unit reached over SSH. The LOCAL unit on a
 * Windows 11 ARM64 host has no POSIX shell, so the local paths run these
 * PowerShell equivalents through powershell.exe instead. We deliberately do
 * NOT fall back to WSL or to the system `bash` (which on Windows is WSL).
 *
 * The output contract matches the bash programs:
 *   - exit marker line:  `__TEEXIT__<nonce>:<code>` / `__SDEXIT__<nonce>:<code>`
 *   - run / log / pid / exit files under  $HOME\.cache\sparkdash\...
 *   - a live tail-follow while the child runs
 * so the JS parsers (exit-marker regex, line splitter) stay untouched.
 *
 * Template-literal escaping rules used throughout this file (see probe notes):
 *   - a literal backtick in the emitted PowerShell is spliced as ${BT},
 *   - a PowerShell variable is written as a bare $name (JS does not interpolate
 *     a lone $, only ${), so it passes through to PowerShell untouched,
 *   - a value the dashboard itself must inject (a nonce, a base64 payload, a
 *     marker prefix) is a normal ${} interpolation.
 */
import { IS_WINDOWS_HOST } from "./windowsProgram.js";
import { TOOL_EVAL_VENV } from "../config.js";

export { IS_WINDOWS_HOST };
const IS_LOCAL_WINDOWS = IS_WINDOWS_HOST;
/** The local unit's tool-eval-bench virtual environment (installed with pip, never uv). */
const VENV = TOOL_EVAL_VENV;

const BT = String.fromCharCode(96); // literal backtick for PowerShell (NUL/CR/LF)

const PATH_BOOTSTRAP =
  '$env:PATH = "$env:USERPROFILE\\.local\\bin;$env:USERPROFILE\\.cargo\\bin;$env:LOCALAPPDATA\\Microsoft\\WindowsApps;$env:PATH"';

/** Resolve an installed executable's path, or empty string when absent. */
const PATH_LOOKUP = (name) => `(Get-Command ${name} -ErrorAction SilentlyContinue).Source`;

/** A literal single-quoted PowerShell string (no interpolation, '' escapes a quote). */
const psQuote = (s) => `'${String(s).replace(/'/g, "''")}'`;

/**
 * Preamble shared by every Tool Eval program.
 *
 * The encoding part is not cosmetic: Windows PowerShell emits text in the console's
 * ANSI/OEM code page (CP936 on a Chinese Windows), while the dashboard reads the child's
 * stdout as UTF-8. Every localized message — .NET exception text, pip/git warnings —
 * therefore reached the output pane as mojibake ("���…"). Pinning both directions to
 * UTF-8 makes what the program prints and what the server decodes agree.
 */
const PS_HEADER = [
  `$ErrorActionPreference = "Continue"`,
  // Keep the progress stream out of stderr: PowerShell serializes it as CLIXML and it
  // would otherwise show up as garbage in the Tool Eval output pane.
  `$ProgressPreference = "SilentlyContinue"`,
  `[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false`,
  `$OutputEncoding = [Console]::OutputEncoding`,
].join("\n");

/**
 * Location bootstrap for the Tool Eval programs. Defines $VENV / $SCRIPTS / $PY
 * for the configured virtual environment and puts its Scripts dir FIRST on PATH so
 * `python` and `pip` resolve to the venv (the rest of the existing PATH — git, … —
 * is kept, so `pip install git+…` can still reach git). This replaces PATH_BOOTSTRAP
 * for the tool-eval programs only; the LLM-launch programs keep PATH_BOOTSTRAP.
 */
const VENV_BOOTSTRAP = [
  PS_HEADER,
  `$VENV = "${VENV}"`,
  `$SCRIPTS = Join-Path $VENV "Scripts"`,
  `$PY = Join-Path $SCRIPTS "python.exe"`,
  `$env:PATH = "$SCRIPTS;" + $env:PATH`,
].join("\n");

/** Resolve tool-eval-bench from the venv Scripts dir, else fall back to PATH. */
const VENV_BIN_LOOKUP =
  `if (Test-Path (Join-Path $SCRIPTS "tool-eval-bench.exe")) { Join-Path $SCRIPTS "tool-eval-bench.exe" } else { ${PATH_LOOKUP("tool-eval-bench")} }`;

/** Kill a process and its direct children (Windows has no process groups). */
function killTree(varName = "runPid") {
  return [
    `function KillTree([int]$${varName}) {`,
    `  if ($${varName} -le 0) { return }`,
    `  $kids = Get-CimInstance Win32_Process -Filter "ParentProcessId=$${varName}" -ErrorAction SilentlyContinue`,
    `  foreach ($k in $kids) { try { Stop-Process -Id $k.ProcessId -Force -ErrorAction Stop } catch {} }`,
    `  try { Stop-Process -Id $${varName} -Force -ErrorAction Stop } catch {}`,
    `}`,
  ].join("\n");
}

/** Tail a log file, emitting only new lines, until the exit file appears. */
function followTail(maxMs) {
  return [
    `function FollowTail($L, $X, $MaxMs) {`,
    `  $deadline = (Get-Date).AddMilliseconds($MaxMs)`,
    `  $lPos = 0`,
    `  while ((Get-Date) -lt $deadline) {`,
    `    if (Test-Path $L) { $lines = @(Get-Content $L -ErrorAction SilentlyContinue); if ($lines.Count -gt $lPos) { foreach ($x in $lines[$lPos..($lines.Count-1)]) { Write-Output $x }; $lPos = $lines.Count } }`,
    `    if ($X -and (Test-Path $X)) { break }`,
    `    Start-Sleep -Milliseconds 700`,
    `  }`,
    `}`,
  ].join("\n");
}

function teMarker(nonce) {
  return `__TEEXIT__${nonce}:`;
}
function sdMarker(nonce) {
  return `__SDEXIT__${nonce}:`;
}

/** Convert a PowerShell program to a base64 -EncodedCommand arg list is done by
 *  the caller (windowsProgram.wrapWindows); these builders return raw PS text. */

/* ══════════════════════════ TOOL EVAL ══════════════════════════ */

/** Detect the tool / python / venv; print Key=value lines (status). */
export function buildStatusProgramWindows() {
  return [
    VENV_BOOTSTRAP,
    // The tool is expected in the venv's Scripts dir (pip console entry point); also
    // fall back to a plain PATH lookup in case it was installed elsewhere.
    `$bin = if (Test-Path (Join-Path $SCRIPTS "tool-eval-bench.exe")) { Join-Path $SCRIPTS "tool-eval-bench.exe" } else { ${PATH_LOOKUP("tool-eval-bench")} }`,
    `Write-Output "BIN=$bin"`,
    `if ($bin) { $v = (& $bin --version 2>&1 | Select-Object -First 1) -join " "; Write-Output "VERSION=$v" }`,
    // uv is not used on Windows: installation goes through pip in the venv above.
    // The key is still printed (empty) so the status parser sees a complete record.
    `Write-Output "UV="`,
    `if (Test-Path $PY) { Write-Output "PYTHON=$PY"; $pv = (& $PY --version 2>&1); Write-Output "PYTHON_VERSION=$pv" } else { Write-Output "PYTHON=" }`,
    `Write-Output "VENV=$VENV"`,
    `$wd = Join-Path $HOME ".sparkdash\\tool-eval"`,
    `Write-Output "WORKDIR=$wd"`,
    ``,
  ].join("\n");
}

/** One-shot tool call (probe / dry-run / version) with base64 NUL-joined argv. */
export function buildOnceProgramWindows({ argvB64, wantStdin = false, nonce = "" }) {
  const readSecrets = wantStdin
    ? [
        `  while (($line = [Console]::In.ReadToEnd()) -ne $null) {`,
        `    $line = $line.TrimEnd("${BT}r"${BT}n")`,
        `    if ($line -eq "") { break }`,
        `    $i = $line.IndexOf("="); if ($i -gt 0) { $k = $line.Substring(0,$i); $v = $line.Substring($i+1); if ($k -in @("TOOL_EVAL_API_KEY","TOOL_EVAL_HEADERS")) { [Environment]::SetEnvironmentVariable($k, [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($v)), "Process") } }`,
        `  }`,
      ].join("\n")
    : "";
  return [
    readSecrets,
    VENV_BOOTSTRAP,
    `$bin = ${VENV_BIN_LOOKUP}`,
    `if (-not $bin) { Write-Output "tool-eval-bench is not installed in ${VENV}"; Write-Output "${teMarker(nonce)}127"; exit 0 }`,
    `$argv = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${argvB64}')).Split("${BT}0") | Where-Object { $_.Length -gt 0 }`,
    `$wd = Join-Path $HOME ".sparkdash\\tool-eval"`,
    `New-Item -ItemType Directory -Force -Path $wd | Out-Null`,
    `Push-Location $wd`,
    `try {`,
    `  $p = Start-Process -FilePath $bin -ArgumentList $argv -NoNewWindow -PassThru -WindowStyle Hidden`,
    `  $p.WaitForExit(90000)`,
    `  $code = $p.ExitCode`,
    `} catch { $code = 1 } finally { Pop-Location }`,
    `Write-Output "${teMarker(nonce)}$code"`,
    ``,
  ].join("\n");
}

/** Latest commit of the tool on GitHub (run from the host, which has internet). */
export function buildUpdateCheckProgramWindows() {
  return [
    PS_HEADER,
    // GitHub requires TLS 1.2+. Windows PowerShell 5.1 negotiates TLS 1.0 by default and
    // the request then dies with a localized "the underlying connection was closed" text.
    `[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12`,
    `try {`,
    `  $req = [System.Net.HttpWebRequest]::Create("https://api.github.com/repos/SeraphimSerapis/tool-eval-bench/commits/HEAD")`,
    `  $req.Method = "GET"; $req.UserAgent = "sparkdash"`,
    // Accept is a restricted header: Headers.Add() throws "must use the appropriate
    // property or method" — it has to go through the Accept property.
    `  $req.Accept = "application/vnd.github+json"; $req.Timeout = 15000`,
    `  $resp = $req.GetResponse(); $reader = New-Object System.IO.StreamReader($resp.GetResponseStream()); $body = $reader.ReadToEnd(); $resp.Close()`,
    `  $d = $body | ConvertFrom-Json`,
    `  Write-Output ("LATEST=" + $d.sha)`,
    `  Write-Output ("LATEST_DATE=" + $d.commit.committer.date)`,
    // One line only: the reason is shown inline in the update notice, so a multi-line
    // .NET exception would break the parser and the layout.
    `} catch {`,
    `  $m = ([string]$_.Exception.Message) -replace "${BT}r?${BT}n", " "`,
    `  Write-Output ("ERROR=" + $m.Substring(0, [Math]::Min(200, $m.Length)))`,
    `}`,
    ``,
  ].join("\n");
}

/**
 * Install / upgrade the tool with pip into the configured virtual environment
 * (never uv). Runs the venv's own python (`-m pip`) so the package lands in
 * $VENV whether or not the venv is on PATH. Prints the exact command first.
 */
export function buildInstallProgramWindows({ extras = [], upgrade = false, nonce = "" }) {
  const ex = (extras || []).filter((e) => ["perf", "hf"].includes(e));
  const src = "git+https://github.com/SeraphimSerapis/tool-eval-bench.git";
  const target = ex.length ? `tool-eval-bench[${ex.join(",")}] @ ${src}` : src;
  // `pip install --upgrade` covers both a first install and an in-place upgrade,
  // so the upgrade flag only changes the displayed verb. The target is a literal
  // single-quoted PowerShell string: no escaping layer, no interpolation.
  const pipArgs = `install --upgrade ${psQuote(target)}`;
  return [
    VENV_BOOTSTRAP,
    `if (-not (Test-Path $PY)) {`,
    `  Write-Output "[sparkdash] the python virtual environment was not found: $VENV"`,
    `  Write-Output "[sparkdash] create it first (python -m venv ${VENV}), then retry."`,
    `  Write-Output "${teMarker(nonce)}127"; exit 0`,
    `}`,
    `Write-Output "[sparkdash] ${upgrade ? "upgrading" : "installing"} into $VENV"`,
    `Write-Output ${psQuote(`[sparkdash] $ & "${VENV}\\Scripts\\python.exe" -m pip ${pipArgs}`)}`,
    // Run the venv python by full path so it is independent of the PATH bootstrap.
    `& $PY -m pip ${pipArgs} 2>&1 | ForEach-Object { Write-Host $_ }`,
    `$code = $LASTEXITCODE`,
    // pip can exit non-zero on a Windows box with a noisy cleanup hook even though the
    // install landed. Trust the artifact: if the console script is there and answers
    // --version, the install succeeded.
    `if ($code -ne 0) {`,
    `  $exe = Join-Path $SCRIPTS "tool-eval-bench.exe"`,
    `  if (Test-Path $exe) {`,
    `    $v = (& $exe --version 2>&1 | Select-Object -First 1) -join " "`,
    `    if ($v) { Write-Output "[sparkdash] pip exited $code but the CLI is installed: $v"; $code = 0 }`,
    `  }`,
    `}`,
    `Write-Output "${teMarker(nonce)}$code"`,
    ``,
  ].join("\n");
}

/** Start a detached benchmark run and follow its output. */
export function buildRunProgramWindows({ runId, argvB64, displayLine, nonce = "" }) {
  const rd = `$HOME\\.cache\\sparkdash\\tooleval\\${runId}`;
  const wd = `$HOME\\.local\\share\\sparkdash\\tool-eval`;
  const display = Buffer.from(String(displayLine ?? ""), "utf8").toString("base64");
  return [
    VENV_BOOTSTRAP,
    `function DecodeB64([string]$s) { [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($s)) }`,
    killTree("runPid"),
    `$RD = "${rd}"; $WD = "${wd}"`,
    `New-Item -ItemType Directory -Force -Path $RD | Out-Null`,
    `New-Item -ItemType Directory -Force -Path $WD | Out-Null`,
    `$L = "$RD\\stdout.log"; $E = "$RD\\events.jsonl"; $X = "$RD\\exit"; $P = "$RD\\pid"`,
    // The venv Scripts dir is first on PATH, so the console shim runs under the venv python.
    `$bin = ${VENV_BIN_LOOKUP}`,
    `if (-not $bin) { Write-Output "[sparkdash] tool-eval-bench is not installed in ${VENV}. Use Set up on the Tool Eval page to install it."; Write-Output "${teMarker(nonce)}127"; exit 0 }`,
    `$runPid = 0; if (Test-Path $P) { $v=[int](Get-Content $P -ErrorAction SilentlyContinue | Select-Object -First 1); if($v){$runPid=$v} }`,
    `if ($runPid -gt 0 -and (Get-Process -Id $runPid -ErrorAction SilentlyContinue)) { Write-Output "[sparkdash] this run is already running"; Write-Output "${teMarker(nonce)}-1"; exit 0 }`,
    `$argv = (DecodeB64 '${argvB64}').Split("${BT}0") | Where-Object { $_.Length -gt 0 }`,
    `Push-Location $WD`,
    `try {`,
    `  if (Test-Path $X) { Remove-Item $X -Force }`,
    `  Set-Content -Path $L -Value "[sparkdash] " + (DecodeB64 '${display}') -NoNewline`,
    `  $p = Start-Process -FilePath $bin -ArgumentList $argv -NoNewWindow -PassThru -WindowStyle Hidden -RedirectStandardOutput $L -RedirectStandardError $E`,
    `  $runPid = $p.Id`,
    `  Set-Content -Path $P -Value $runPid`,
    `  $p.WaitForExit()`,
    `  $code = $p.ExitCode`,
    `  Set-Content -Path $X -Value $code`,
    `  Remove-Item $P -Force -ErrorAction SilentlyContinue`,
    `  Write-Output "${teMarker(nonce)}$code"`,
    `} finally { Pop-Location }`,
    ``,
  ].join("\n");
}

/** Re-open the output of a running / finished run. */
export function buildAttachProgramWindows({ runId, nonce = "" }) {
  const rd = `$HOME\\.cache\\sparkdash\\tooleval\\${runId}`;
  return [
    `$ErrorActionPreference = "Continue"`,
    followTail(0),
    `$RD = "${rd}"`,
    `$L = "$RD\\stdout.log"; $E = "$RD\\events.jsonl"; $X = "$RD\\exit"; $P = "$RD\\pid"`,
    `if (-not (Test-Path $L)) { Write-Output "[sparkdash] no output was recorded for this run on the Spark"; Write-Output "${teMarker(nonce)}-1"; exit 0 }`,
    `$runPid = 0; if (Test-Path $P) { $v=[int](Get-Content $P -ErrorAction SilentlyContinue | Select-Object -First 1); if($v){$runPid=$v} }`,
    `$alive = ($runPid -gt 0) -and (Get-Process -Id $runPid -ErrorAction SilentlyContinue) -and (-not (Test-Path $X))`,
    `if ($alive) { FollowTail $L $X 3600000 } else {`,
    `  $t = @(Get-Content $L -ErrorAction SilentlyContinue); if ($t) { foreach ($x in $t) { Write-Output $x } }`,
    `  $e = @(Get-Content $E -ErrorAction SilentlyContinue); if ($e) { foreach ($x in $e) { Write-Output $x } }`,
    `}`,
    `$code = -1; if (Test-Path $X) { $code = [int](Get-Content $X | Select-Object -First 1) }`,
    `Write-Output "${teMarker(nonce)}$code"`,
    ``,
  ].join("\n");
}

/** Stop a running run (kill its tree). */
export function buildStopProgramWindows({ runId }) {
  const rd = `$HOME\\.cache\\sparkdash\\tooleval\\${runId}`;
  return [
    `$ErrorActionPreference = "Continue"`,
    killTree("runPid"),
    `$RD = "${rd}"`,
    `$P = "$RD\\pid"; $X = "$RD\\exit"`,
    `$tries = 0`,
    `while ($tries -lt 10 -and -not (Test-Path $P) -and -not (Test-Path $X)) { Start-Sleep -Milliseconds 500; $tries++ }`,
    `$runPid = 0; if (Test-Path $P) { $v=[int](Get-Content $P -ErrorAction SilentlyContinue | Select-Object -First 1); if($v){$runPid=$v} }`,
    `if ($runPid -le 0 -or -not (Get-Process -Id $runPid -ErrorAction SilentlyContinue)) { Write-Output "not running"; exit 0 }`,
    `KillTree $runPid`,
    `$wait = 0`,
    `while ($wait -lt 8 -and (Get-Process -Id $runPid -ErrorAction SilentlyContinue)) { Start-Sleep -Seconds 1; $wait++ }`,
    `if (Get-Process -Id $runPid -ErrorAction SilentlyContinue) { Write-Output "killed" } else { Write-Output "stopped" }`,
    ``,
  ].join("\n");
}

/** Read the result file back (size-guarded). */
export function buildReadResultProgramWindows({ runId, maxBytes = 30 * 1024 * 1024 }) {
  const rd = `$HOME\\.cache\\sparkdash\\tooleval\\${runId}`;
  return [
    `$ErrorActionPreference = "Continue"`,
    `$R = "${rd}\\result.json"`,
    `if (-not (Test-Path $R)) { Write-Output "__NORESULT__"; exit 0 }`,
    `$sz = (Get-Item $R).Length`,
    `if ($sz -gt ${maxBytes}) { Write-Output "__TOOBIG__$sz"; exit 0 }`,
    `Write-Output (Get-Content $R -Raw)`,
    ``,
  ].join("\n");
}

/** Is a run still alive, gone, or finished? Mirrors buildCheckProgram's contract. */
export function buildCheckProgramWindows({ runId }) {
  const rd = `$HOME\\.cache\\sparkdash\\tooleval\\${runId}`;
  return [
    `$ErrorActionPreference = "Continue"`,
    `$RD = "${rd}"`,
    `$P = "$RD\\pid"; $X = "$RD\\exit"`,
    `if (-not (Test-Path $RD)) { Write-Output "GONE"; exit 0 }`,
    `$runPid = 0; if (Test-Path $P) { $v=[int](Get-Content $P -ErrorAction SilentlyContinue | Select-Object -First 1); if($v){$runPid=$v} }`,
    `$alive = ($runPid -gt 0) -and (Get-Process -Id $runPid -ErrorAction SilentlyContinue) -and (-not (Test-Path $X))`,
    `if ($alive) { Write-Output "ALIVE" } else { $c = -1; if (Test-Path $X) { $c = [int](Get-Content $X | Select-Object -First 1) }; Write-Output "EXIT=$c" }`,
    ``,
  ].join("\n");
}

/** Remove a run's files (best effort). Mirrors buildDeleteRunProgram. */
export function buildDeleteRunProgramWindows({ runId }) {
  const rd = `$HOME\\.cache\\sparkdash\\tooleval\\${runId}`;
  return [
    `$ErrorActionPreference = "SilentlyContinue"`,
    `$RD = "${rd}"`,
    `if (Test-Path $RD) { Remove-Item $RD -Recurse -Force }`,
    `Write-Output "ok"`,
    ``,
  ].join("\n");
}

/** Build a Tool Eval program; PowerShell when local+Windows, else null (use bash). */
export function teProgramWindows(action, opts = {}) {
  if (!IS_LOCAL_WINDOWS) return null; // caller falls back to the bash builder
  const program = buildTeProgramWindows(action, opts);
  // One preamble for every action: UTF-8 output, no progress stream. Builders that
  // already start with it (the venv ones) are left alone.
  return program.includes(PS_HEADER) ? program : `${PS_HEADER}\n${program}`;
}

function buildTeProgramWindows(action, opts) {
  switch (action) {
    case "status": return buildStatusProgramWindows();
    case "once": return buildOnceProgramWindows(opts);
    case "update-check": return buildUpdateCheckProgramWindows();
    case "install": return buildInstallProgramWindows(opts);
    case "run": return buildRunProgramWindows(opts);
    case "attach": return buildAttachProgramWindows(opts);
    case "stop": return buildStopProgramWindows(opts);
    case "check": return buildCheckProgramWindows(opts);
    case "read-result": return buildReadResultProgramWindows(opts);
    case "delete": return buildDeleteRunProgramWindows(opts);
    default: throw new Error(`unknown tool-eval action: ${action}`);
  }
}

/* ══════════════════════════ LLM LAUNCH ══════════════════════════ */

/** How to launch a user start/stop script of any supported type. */
const INVOKE = [
  `$ext = [System.IO.Path]::GetExtension($script).ToLower()`,
  `$exe = $null; $a = @()`,
  `if ($ext -eq ".ps1") { $exe = (Get-Command powershell -ErrorAction SilentlyContinue).Source; $a = @("-NoProfile","-ExecutionPolicy","Bypass","-File",$scriptPath) }`,
  `elseif ($ext -eq ".bat" -or $ext -eq ".cmd") { $exe = "cmd"; $a = @("/c",$scriptPath) }`,
  `elseif ($ext -eq ".py") { $exe = (Get-Command python -ErrorAction SilentlyContinue).Source; if ($exe) { $a = @($scriptPath) } }`,
  `else { $exe = $scriptPath; $a = @() }`,
].join("\n");

function dirToWin(dir) {
  if (!dir) return dir;
  if (dir.startsWith("~/")) return `$HOME${dir.slice(2).replace(/\//g, "\\")}`;
  return dir;
}

/** One line per launcher id: "<id> RUNNING|STOPPED" from the local pid files. */
export function buildStatusCommandWindows(ids) {
  // PowerShell array literal: @("m1","m2"). (Not JSON — ConvertFrom-Json expects a string.)
  const list = (ids || []).map((x) => `"${String(x).replace(/"/g, '""')}"`).join(",");
  return [
    `$ErrorActionPreference = "Continue"`,
    `$LD = "$HOME\\.cache\\sparkdash\\llm"`,
    `$ids = @(${list})`,
    `foreach ($id in $ids) {`,
    `  $runPid = 0; if (Test-Path "$LD\\$id.pid") { $v=[int](Get-Content "$LD\\$id.pid" -ErrorAction SilentlyContinue | Select-Object -First 1); if($v){$runPid=$v} }`,
    `  $alive = ($runPid -gt 0) -and (Get-Process -Id $runPid -ErrorAction SilentlyContinue)`,
    `  $st = if ($alive) { "RUNNING" } else { "STOPPED" }`,
    `  Write-Output "$id $st"`,
    `}`,
    ``,
  ].join("\n");
}

/** Start a registered LLM's start script and stream it. */
export function buildStartCommandWindows({ id, dir, script, nonce }) {
  const m = sdMarker(nonce);
  return [
    `$ErrorActionPreference = "Continue"`,
    `$LD = "$HOME\\.cache\\sparkdash\\llm"`,
    `New-Item -ItemType Directory -Force -Path $LD | Out-Null`,
    `$L = "$LD\\${id}.log"; $E = "$LD\\${id}.err"; $X = "$LD\\${id}.exit"; $P = "$LD\\${id}.pid"`,
    `function IsAlive([int]$x) { if ($x -le 0) { return $false }; return [bool](Get-Process -Id $x -ErrorAction SilentlyContinue) }`,
    `$runPid = 0; if (Test-Path $P) { $v=[int](Get-Content $P -ErrorAction SilentlyContinue | Select-Object -First 1); if($v){$runPid=$v} }`,
    `if (IsAlive $runPid) {`,
    `  Write-Output "[sparkdash] already running (pid $runPid); not starting a second copy. Showing its output"`,
    `  $lPos = 0; $ePos = 0`,
    `  $deadline = (Get-Date).AddSeconds(3600)`,
    `  while ((Get-Date) -lt $deadline -and IsAlive $runPid) {`,
    `    if (Test-Path $L) { $lines = @(Get-Content $L -ErrorAction SilentlyContinue); if ($lines.Count -gt $lPos) { foreach ($x in $lines[$lPos..($lines.Count-1)]) { Write-Output $x }; $lPos = $lines.Count } }`,
    `    if (Test-Path $E) { $elines = @(Get-Content $E -ErrorAction SilentlyContinue); if ($elines.Count -gt $ePos) { foreach ($x in $elines[$ePos..($elines.Count-1)]) { Write-Output $x }; $ePos = $elines.Count } }`,
    `    Start-Sleep -Milliseconds 700`,
    `  }`,
    `  $c = -1; if (Test-Path $X) { $c = [int](Get-Content $X | Select-Object -First 1) }`,
    `  Write-Output "${m}$c"; exit 0`,
    `}`,
    `$dir = "${dirToWin(dir)}"`,
    `if (-not (Test-Path $dir)) { Write-Output "[sparkdash] cannot open directory $dir"; Write-Output "${m}127"; exit 0 }`,
    `$scriptPath = Join-Path $dir ${JSON.stringify(script)}`,
    `if (-not (Test-Path $scriptPath)) { Write-Output "${m}127"; exit 0 }`,
    `if (Test-Path $X) { Remove-Item $X -Force }`,
    `if (Test-Path $P) { Remove-Item $P -Force }`,
    `Set-Content -Path $L -Value ""`,
    `Set-Content -Path $E -Value ""`,
    `Write-Output "[sparkdash] starting ${script}"`,
    INVOKE,
    `if (-not $exe) { Write-Output "${m}127"; exit 0 }`,
    `$p = Start-Process -FilePath $exe -ArgumentList $a -NoNewWindow -PassThru -WindowStyle Hidden -WorkingDirectory $dir -RedirectStandardOutput $L -RedirectStandardError $E`,
    `$runPid = $p.Id`,
    `Set-Content -Path $P -Value $runPid`,
    `$deadline = (Get-Date).AddSeconds(3600)`,
    `$lPos = 0; $ePos = 0`,
    `while ((Get-Date) -lt $deadline -and IsAlive $runPid) {`,
    `  if (Test-Path $L) { $lines = @(Get-Content $L -ErrorAction SilentlyContinue); if ($lines.Count -gt $lPos) { foreach ($x in $lines[$lPos..($lines.Count-1)]) { Write-Output $x }; $lPos = $lines.Count } }`,
    `  if (Test-Path $E) { $elines = @(Get-Content $E -ErrorAction SilentlyContinue); if ($elines.Count -gt $ePos) { foreach ($x in $elines[$ePos..($elines.Count-1)]) { Write-Output $x }; $ePos = $elines.Count } }`,
    `  Start-Sleep -Milliseconds 700`,
    `}`,
    `$code = $p.ExitCode`,
    `Set-Content -Path $X -Value $code`,
    `Write-Output "${m}$code"`,
    ``,
  ].join("\n");
}

/** Show the log of a registered LLM (running or last run). */
export function buildAttachCommandWindows({ id, nonce }) {
  const m = sdMarker(nonce);
  return [
    `$ErrorActionPreference = "Continue"`,
    `$LD = "$HOME\\.cache\\sparkdash\\llm"`,
    `$L = "$LD\\${id}.log"; $E = "$LD\\${id}.err"; $X = "$LD\\${id}.exit"`,
    `if (-not (Test-Path $L) -and -not (Test-Path $E)) { Write-Output "[sparkdash] no output recorded yet for this model"; Write-Output "${m}-1"; exit 0 }`,
    `$lines = @()`,
    `if (Test-Path $L) { $lines += @(Get-Content $L -ErrorAction SilentlyContinue) }`,
    `if (Test-Path $E) { $lines += @(Get-Content $E -ErrorAction SilentlyContinue) }`,
    `if ($lines.Count -gt 500) { $lines = $lines[($lines.Count-500)..($lines.Count-1)] }`,
    `foreach ($x in $lines) { Write-Output $x }`,
    `$c = -1; if (Test-Path $X) { $c = [int](Get-Content $X | Select-Object -First 1) }`,
    `Write-Output "${m}$c"`,
    ``,
  ].join("\n");
}

/** Run a registered LLM's stop script (attached). */
export function buildStopCommandWindows({ dir, script, nonce }) {
  const m = sdMarker(nonce);
  return [
    `$ErrorActionPreference = "Continue"`,
    `$dir = "${dirToWin(dir)}"`,
    `if (-not (Test-Path $dir)) { Write-Output "[sparkdash] cannot open directory ${dir}"; Write-Output "${m}127"; exit 0 }`,
    `$scriptPath = Join-Path $dir ${JSON.stringify(script)}`,
    `if (-not (Test-Path $scriptPath)) { Write-Output "${m}127"; exit 0 }`,
    `Write-Output "[sparkdash] running ${script}"`,
    INVOKE,
    `if (-not $exe) { Write-Output "${m}127"; exit 0 }`,
    `$p = Start-Process -FilePath $exe -ArgumentList $a -NoNewWindow -PassThru -WorkingDirectory $dir`,
    `$p.WaitForExit(900000)`,
    `$code = $p.ExitCode`,
    `Write-Output "${m}$code"`,
    ``,
  ].join("\n");
}

/** Build an LLM-launch program; PowerShell when local+Windows, else null (use bash). */
export function sdProgramWindows(action, opts = {}) {
  if (!IS_LOCAL_WINDOWS) return null; // caller falls back to the bash builder
  switch (action) {
    case "status": return buildStatusCommandWindows(opts.ids || []);
    case "start": return buildStartCommandWindows(opts);
    case "attach": return buildAttachCommandWindows(opts);
    case "stop": return buildStopCommandWindows(opts);
    default: throw new Error(`unknown llm-launch action: ${action}`);
  }
}
