# start.ps1 - serve the sparkDash monitoring dashboard on Windows 11 ARM64 (native: no Docker, no WSL).
# SPDX-License-Identifier: Apache-2.0
#
# Launches `node server/index.js` with the ARM64-native Node in D:\llm\node-arm64, waits until
# /api/health answers, then reports the URL. Stop with .\stop.ps1. The Node app is pure JavaScript
# - there is no Python venv to boot - so the whole lifecycle is: check Node + built frontend,
# launch, wait for the HTTP health endpoint, done.
#
# Usage (PowerShell):  .\start.ps1 [restart] [check-env] [help]
#   .\start.ps1                              start (or, if already running, say so and exit)
#   .\start.ps1 restart                      stop the running server, then start it again
#   .\start.ps1 check-env                    verify Node / frontend / port (no server started)
#   .\start.ps1 help                         show this help
#
# Override any setting from the environment (e.g. $env:PORT=9000) or a ./.env file (KEY=value lines).

$ErrorActionPreference = "Stop"
$MyDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
. (Join-Path $MyDir "scripts/config.ps1")
. (Join-Path $MyDir "scripts/banner.ps1")

$usage = @"
Serve sparkDash (native Windows ARM64, no container, no WSL).

  .\start.ps1                start (or, if already running, say so and exit)
  .\start.ps1 restart        stop the running server, then start it again
  .\start.ps1 check-env      verify the Node runtime / built frontend / port (no server started)
  .\start.ps1 clean-env      drop stale sparkDash variables this console is still carrying
  .\start.ps1 help           show this help

Settings: NODE (arm64 node.exe path), HOST / BIND_HOST, PORT, LLM_PORT, COMFY_PORT,
  SPARKDASH_TOKEN, SPARKDASH_ALLOW_OPEN_REMOTE, SSH_MULTIPLEX, RUNTIME_DIR,
  WAIT_TIMEOUT, STOP_TIMEOUT, FOREGROUND (see scripts/config.ps1).
"@

# ---------------------------------------------------------------- parse arguments
$Mode = "start"
foreach ($a in $args) {
    if ($a -in @("help", "-h", "--help")) { Write-Host $usage; exit 0 }
    if ($a -eq "restart") { $Mode = "restart"; continue }
    if ($a -eq "check-env") { $Mode = "check-env"; continue }
    if ($a -eq "clean-env") { $Mode = "clean-env"; continue }
    warn "ignoring unknown argument: $a"
}

# ---------------------------------------------------------------- clean-env
# Older versions of this script wrote the launch environment into the caller's process and left it
# there, so a console can still carry a stale token or SPARKDASH_ALLOW_OPEN_REMOTE=0 that no file
# mentions. This removes those keys from the CURRENT window (a script cannot change another window).
# Only sparkDash-specific names are touched: PORT and BIND_HOST are generic enough that the user may
# have set them on purpose.
if ($Mode -eq "clean-env") {
    $stale = @('SPARKDASH_TOKEN','SPARKDASH_ALLOW_OPEN_REMOTE','SPARKDASH_HOST_NETWORK','SPARKDASH_MQTT_PASSWORD',
               'SPARKDASH_APIKEYS_BRIDGE_SOCKET','SPARKDASH_APIKEYS_BRIDGE_TOKEN','LLM_PORT','COMFY_PORT',
               'SSH_MULTIPLEX','TOOL_EVAL_VENV','NODE_ENV')
    $removed = 0
    foreach ($k in $stale) {
        $v = [Environment]::GetEnvironmentVariable($k, 'Process')
        if ($null -eq $v) { continue }
        $shown = if ($v -eq "") { "<empty>" } elseif ($k -like "*TOKEN*" -or $k -like "*PASSWORD*") { "length $($v.Length)" } else { $v }
        [Environment]::SetEnvironmentVariable($k, $null, 'Process')
        log "removed $k=$shown"
        $removed++
    }
    if ($removed -eq 0) { log "this window carries no stale sparkDash variables" }
    else { log "cleaned $removed variable(s) from this window; .env is the only source now" }
    exit 0
}

# Where to reach the server from this machine: a wildcard bind answers on loopback.
$ApiHost = $BIND_HOST
if ($BIND_HOST -eq "0.0.0.0" -or $BIND_HOST -eq "::") { $ApiHost = "127.0.0.1" }
$URL = "http://${ApiHost}:${PORT}"

# ---------------------------------------------------------------- check-env
if ($Mode -eq "check-env") {
    Write-Host "Environment (no server started):"
    $nodeCmd = Get-Command $NODE -ErrorAction SilentlyContinue
    if ($nodeCmd) {
        $ver = (& $NODE --version 2>$null)
        $arch = (& $NODE -p "process.arch" 2>$null)
        Write-Host ("  NODE     {0}  ({1}, {2})" -f $nodeCmd.Source, $ver, $arch)
        if ("$arch" -ne "arm64") { warn "Node reports arch '$arch', not arm64. On GB10 an x64 build runs under emulation and is much slower." }
    } else {
        Write-Host "  NODE     NOT FOUND at $NODE (set NODE to your arm64 node.exe)"
    }
    $frontend = (Test-Path (Join-Path $RepoRoot "dist\index.html"))
    Write-Host ("  FRONTEND {0}" -f $(if ($frontend) { "built (dist/index.html present)" } else { "NOT BUILT - run: npm run build" }))
    Write-Host ("  BIND     {0}   PORT {1}" -f $BIND_HOST, $PORT)
    Write-Host ("  URL      {0}" -f $URL)
    Write-Host ("  CPU cores  {0}" -f $env:NUMBER_OF_PROCESSORS)
    if ("$SSH_MULTIPLEX" -eq "1") { warn "SSH_MULTIPLEX=1 has no effect on Windows OpenSSH (no ControlMaster); it is ignored for local collectors" }
    exit 0
}

New-Item -ItemType Directory -Force -Path $RUNTIME_DIR | Out-Null
$pidFile = Join-Path $RUNTIME_DIR "sparkdash.pid"
$logOut  = Join-Path $RUNTIME_DIR "server.out.log"
$logErr  = Join-Path $RUNTIME_DIR "server.err.log"

function Get-SavedPid {
    if (Test-Path $pidFile) {
        $p = (Get-Content $pidFile -Raw).Trim()
        if ($p -match '^\d+$') { return [int]$p }
    }
    return $null
}

# ---------------------------------------------------------------- banner
$B = "$([char]27)[1m"; $M = "$([char]27)[1;38;2;110;215;80m"; $G = "$([char]27)[1;38;2;60;200;130m"
$D = "$([char]27)[2m"; $R = "$([char]27)[0m"
if ([Console]::IsOutputRedirected) { $B=$M=$G=$D=$R="" }
Show-SparkDashBanner
Write-Host ""
Show-SparkDashBannerCaption
Write-Host ("${D}${URL}${R} · bind ${M}${BIND_HOST}${R} · arm64 node · ${M}${RUNTIME_DIR}${R}")
$STEPS = 4
function step($n, $msg) { Write-Host ("${M}[$n/$STEPS]${R} ${B}$msg${R}") }

# ---------------------------------------------------------------- already running?
$saved = Get-SavedPid
if ($saved -and -not (Test-SparkDashProcess $saved)) {
    # A live PID is not enough: Windows recycles PIDs, and a stale file would otherwise make this
    # script report "already running" and exit while nothing serves the dashboard.
    warn "ignoring $pidFile (PID $saved): that process is not this sparkDash server. Removing it."
    Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
    $saved = $null
}
if ($saved) {
    if ($Mode -eq "start") {
        log "PID $saved is already running (port $PORT): nothing to do."
        log "Use '.\start.ps1 restart' to restart it, or '.\stop.ps1' to stop it."
        exit 0
    }
} elseif ($Mode -eq "restart") {
    warn "no running server found under $pidFile (or its PID is dead); starting fresh"
}

# ---------------------------------------------------------------- 1. setup / readiness
step 1 "Setup: Node runtime + built frontend"
if (-not (Test-Path $NODE)) { die "arm64 Node not found at $NODE (set NODE, or install node-arm64)" }
$frontend = (Test-Path (Join-Path $RepoRoot "dist\index.html"))
if (-not $frontend) {
    die "frontend not built: dist/index.html is missing. Run: $NODE D:\llm\node-arm64\npm.cmd run build"
}
log "Node at $NODE ; frontend built; no venv required (pure Node)."

# ---------------------------------------------------------------- 2. checks
step 2 "Checks: previous server, port"
if ($Mode -eq "restart" -and $saved) {
    log "Stopping the previous server (PID $saved) before restart"
    & (Join-Path $MyDir "stop.ps1")
    Start-Sleep -Seconds 2
}
# Only an identified owner counts as "occupied": right after a stop, the port still shows
# FIN_WAIT_1/TIME_WAIT rows for a moment with no process behind them. Failing on those would
# report "in use by PID  (unknown process)" for a port that is actually free.
$owner = Get-PortOwnerPid $PORT
if (-not $owner -and (Test-PortListening $PORT)) {
    # The port refuses a bind but no process owns it: a server that was just killed is still closing
    # its socket. Give it a moment instead of declaring the port foreign.
    log "port $PORT is not bindable but has no visible owner; it may still be closing - waiting up to 5s"
    for ($i = 0; $i -lt 5; $i++) {
        Start-Sleep -Seconds 1
        $owner = Get-PortOwnerPid $PORT
        if ($owner) { break }
        if (-not (Test-PortListening $PORT)) { break }
    }
}
if ($owner) {
    if (Test-SparkDashProcess $owner) {
        if ($Mode -eq "restart") {
            # Only `restart` may replace a running server: stop the untracked instance, then go on.
            log "port $PORT is held by this sparkDash server (PID $owner); stopping it for the restart"
            & (Join-Path $MyDir "stop.ps1")
            Start-Sleep -Seconds 2
            if (Get-PortOwnerPid $PORT) { die "port $PORT is still in use after stopping PID $owner. Free it manually, or set PORT=<other>." }
        } else {
            # A plain `start` NEVER stops a healthy server: adopt it, record its PID, and stand down.
            log "sparkDash is already running (PID $owner on port $PORT), though the PID file was missing or stale."
            $owner | Set-Content -Path $pidFile
            log "Recorded PID $owner in $pidFile. Use '.\start.ps1 restart' to replace it, or '.\stop.ps1' to stop it."
            exit 0
        }
    } else {
        $cmd = Get-ProcCommandLine $owner
        die "port $PORT is already in use by PID $owner ($cmd). Refusing to touch a process that is not sparkDash; stop it yourself, or set PORT=<other>."
    }
} elseif (Test-PortListening $PORT) {
    # The socket is there but the kernel will not name its owner. That is what a server started from
    # an elevated console looks like to a non-elevated shell (netstat reports PID 0), so ask the
    # listener what it is instead of guessing. Never stop it from here: `start` does not kill.
    if (Test-SparkDashHttp $URL $SPARKDASH_TOKEN) {
        if ($Mode -eq "restart") {
            die "sparkDash is already serving port $PORT, but its PID is not visible to this shell (it was probably started from an elevated window). Run '.\start.ps1 restart' from an administrator window, or stop it there with '.\stop.ps1' first."
        }
        log "sparkDash is already serving port $PORT; its PID is not visible to this shell (likely started from an elevated window), so nothing was started."
        log "Open $URL, or stop it from that window with '.\stop.ps1'."
        exit 0
    }
    die "port $PORT cannot be bound and the holder is not sparkDash (its owner PID is not visible to this shell, or it is still shutting down). Check: netstat -ano | findstr :$PORT"
}
log "port $PORT is free"

# ---------------------------------------------------------------- 3. launch
step 3 "Launch: node server/index.js (PID tracked in $pidFile)"
# Everything from here mutates THIS process's environment so the child inherits it. Because
# .\start.ps1 runs in the caller's console, that write would otherwise survive the script and be
# inherited by every later run from that window. Snapshot now, restore as soon as the child exists.
$launchKeys = @($EnvFile.Keys) + @('PORT','BIND_HOST','SPARKDASH_TOKEN','SPARKDASH_ALLOW_OPEN_REMOTE','SSH_MULTIPLEX','LLM_PORT','COMFY_PORT','NODE_ENV','HTTPS_PROXY','HTTP_PROXY','ALL_PROXY')
$envSnapshot = Get-EnvSnapshot ($launchKeys | Sort-Object -Unique)
# .env lives in a map (config.ps1 keeps it out of the process on purpose). Copy it in now so the
# child inherits the full set, exactly as before - the restore below puts the console back.
foreach ($k in $EnvFile.Keys) { [Environment]::SetEnvironmentVariable($k, $EnvFile[$k], 'Process') }
# Drop duplicate lower/upper-case proxy vars: on Windows an HTTPS_PROXY + https_proxy pair
# makes some env enumeration throw "item with same key".
foreach ($n in 'HTTPS_PROXY','https_proxy','HTTP_PROXY','http_proxy','ALL_PROXY','all_proxy') {
    [Environment]::SetEnvironmentVariable($n, $null, 'Process')
}
# Use the .NET API for env writes: the $env: provider's Set-Item throws "item with same key"
# when the inherited environment has a case-duplicate entry, which would abort the launch.
[Environment]::SetEnvironmentVariable("PORT", "$PORT", "Process")
[Environment]::SetEnvironmentVariable("BIND_HOST", "$BIND_HOST", "Process")
[Environment]::SetEnvironmentVariable("SPARKDASH_TOKEN", $SPARKDASH_TOKEN, "Process")
[Environment]::SetEnvironmentVariable("SPARKDASH_ALLOW_OPEN_REMOTE", "$SPARKDASH_ALLOW_OPEN_REMOTE", "Process")
[Environment]::SetEnvironmentVariable("SSH_MULTIPLEX", "$SSH_MULTIPLEX", "Process")
[Environment]::SetEnvironmentVariable("LLM_PORT", "$LLM_PORT", "Process")
[Environment]::SetEnvironmentVariable("COMFY_PORT", "$COMFY_PORT", "Process")
$nodeEnv = Read-Env NODE_ENV
[Environment]::SetEnvironmentVariable("NODE_ENV", $(if ($nodeEnv) { $nodeEnv } else { "production" }), "Process")

# A remote bind without a token is OPEN (see server/auth.js). Fail closed here so we never
# silently expose the fleet.
if (($BIND_HOST -eq "0.0.0.0" -or $BIND_HOST -eq "::") -and (-not $SPARKDASH_TOKEN) -and ("$SPARKDASH_ALLOW_OPEN_REMOTE" -ne "1")) {
    Restore-EnvSnapshot $envSnapshot
    die "remote bind ($BIND_HOST) without SPARKDASH_TOKEN is refused (SPARKDASH_ALLOW_OPEN_REMOTE=$SPARKDASH_ALLOW_OPEN_REMOTE). Put SPARKDASH_ALLOW_OPEN_REMOTE=1 in .env, or set SPARKDASH_TOKEN, or bind loopback."
}
# Say out loud which mode is in force. A token or open-remote flag that came from the shell instead
# of .env used to change the behaviour with no trace anywhere, which is impossible to debug from the
# browser (it just asks for a token, or refuses to start).
if ($SPARKDASH_TOKEN) {
    log "auth: token required (SPARKDASH_TOKEN is set, length $($SPARKDASH_TOKEN.Length)) - the browser will ask for it"
} else {
    log "auth: no token - anyone who can reach port $PORT gets in (SPARKDASH_ALLOW_OPEN_REMOTE=$SPARKDASH_ALLOW_OPEN_REMOTE, from .env)"
}

if ($FOREGROUND -eq 1) {
    # No PID file here on purpose: this shell is the server's parent and the node child owns the
    # port. stop.ps1 finds it through the port owner, and Ctrl-C unloads it anyway.
    Write-Host "${D}  FOREGROUND mode: Ctrl-C to stop.${R}"
    Push-Location $RepoRoot
    & $NODE "server/index.js"
    $code = $LASTEXITCODE
    Pop-Location
    Restore-EnvSnapshot $envSnapshot
    exit $code
}

# Daemon launch: a hidden node process, with output redirected to the log files. This is the same
# pattern as the proven Qwen3.8/TensorFold start.ps1 on this machine: run .\start.ps1 from a
# console and keep that console open while the dashboard is in use; .\stop.ps1 (or closing the
# console) ends the daemon. node is the directly-tracked PID, so taskkill /T reaps it cleanly.
$proc = Start-Process -FilePath $NODE -ArgumentList @("server/index.js") `
    -WorkingDirectory $RepoRoot -RedirectStandardOutput $logOut -RedirectStandardError $logErr `
    -WindowStyle Hidden -PassThru
$proc.Id | Set-Content -Path $pidFile
$daemonPid = $proc.Id
# The child has its own copy of the environment now; put this console's back the way it was.
Restore-EnvSnapshot $envSnapshot

# ---------------------------------------------------------------- 4. load
step 4 "Starting: waiting for /api/health"
$start = Get-Date
$ready = $false
$nextBeat = 10
while (-not $ready) {
    if (-not (Test-PidAlive $daemonPid)) {
        Write-Host ""
        Write-Host "${D}-- last server log lines (startup failure) --${R}"
        foreach ($p in @($logErr, $logOut)) {
            if (Test-Path $p) { Get-Content $p -Tail 25 -ErrorAction SilentlyContinue | ForEach-Object { "  | $_" } }
        }
        # Drop the PID file we just wrote: leaving a dead PID behind is what makes the next run
        # claim "already running" or force an unnecessary restart.
        Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
        die "the server exited before it was ready (see $logErr)"
    }
    if ((Get-Date) - $start -gt [TimeSpan]::FromSeconds($WAIT_TIMEOUT)) {
        # A listening port plus a failing health probe almost always means the request was refused,
        # not that the server is slow: say so instead of leaving the user to guess.
        if (Test-PortListening $PORT) {
            warn "port $PORT is LISTENING but ${URL}/api/health did not answer. The server is up and the probe was refused or timed out - check SPARKDASH_TOKEN (a tokened bind gates /api/health) and $logErr."
        }
        die "not ready after ${WAIT_TIMEOUT}s (WAIT_TIMEOUT); it is still running: Get-Content $logOut -Wait"
    }
    if (Test-ApiReady $URL) { $ready = $true; break }
    if (((Get-Date) - $start).TotalSeconds -ge $nextBeat) {
        Write-Host "  ${D}⋯ $([int]((Get-Date) - $start).TotalSeconds)s elapsed, waiting for ${URL}...${R}"
        $nextBeat += 10
    }
    Start-Sleep -Seconds 2
}
log "Server answered after $([int]((Get-Date) - $start).TotalSeconds)s (PID $daemonPid)"

# Surface the health payload's warnings (config dir, secrets key, ssh identity) once.
try {
    $h = Invoke-LocalRest -Uri "$URL/api/health" -Method Get -TimeoutSec 5 -Headers (Get-AuthHeaders $SPARKDASH_TOKEN)
    foreach ($w in $h.warnings) { warn "health: $w" }
} catch { }

$IP = $BIND_HOST
if ($BIND_HOST -eq "0.0.0.0" -or $BIND_HOST -eq "::") {
    try { $IP = (Get-NetIPAddress -AddressFamily IPv4 -InterfaceAlias "*" -ErrorAction Stop | Where-Object { $_.IPAddress -notmatch '^127\.' -and $_.IPAddress -notmatch '^169\.254\.' } | Select-Object -First 1).IPAddress } catch { $IP = "<this-host>" }
}
Write-Host ""
Write-Host ("${G}  ✔ sparkDash is now LIVE! on port $PORT${R}")
Write-Host ""
Write-Host "    UI       http://${IP}:$PORT"
Write-Host "    Health   http://${IP}:$PORT/api/health"
Write-Host "    Logs     Get-Content $logOut -Wait"
Write-Host "    Restart  .\start.ps1 restart"
Write-Host "    Stop     .\stop.ps1"
Write-Host ""
