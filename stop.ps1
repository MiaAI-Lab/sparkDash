# stop.ps1 - stop the sparkDash server that start.ps1 started (native Windows ARM64, no Docker).
# SPDX-License-Identifier: Apache-2.0
#
# The server gets STOP_TIMEOUT seconds (default 30) to shut down. It is a single Node process
# (no child workers to reap), so taskkill on the PID is sufficient; a process-tree kill is used
# anyway to be safe.
#
# It stops the server even when .runtime/sparkdash.pid is missing or points at a recycled PID:
# it falls back to whoever is listening on $PORT, and only ever kills a process whose command
# line is this repo's `server/index.js` - never an unrelated program that happens to own the port.
#
# Usage (PowerShell):  .\stop.ps1     Env: PORT, STOP_TIMEOUT, RUNTIME_DIR (see scripts/config.ps1)

$ErrorActionPreference = "Stop"
$MyDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
. (Join-Path $MyDir "scripts/config.ps1")

$RUNTIME_DIR | Out-Null
$pidFile = Join-Path $RUNTIME_DIR "sparkdash.pid"

# ---- 1. who are we stopping? -------------------------------------------------------
# The PID file only exists for servers this repo's start.ps1 daemonised. A server started by
# hand (or with FOREGROUND=1, or one whose pid file was deleted) is invisible to it, and then
# start.ps1 dies with "port 5555 is already in use" while stop.ps1 says "nothing to stop".
# So: trust the PID file only when that PID really is our server, then fall back to the port owner.
$serverPid = $null
if (Test-Path $pidFile) {
    $raw = (Get-Content $pidFile -Raw).Trim()
    if ($raw -notmatch '^\d+$') {
        warn "PID file does not contain a PID ('$raw'); removing it."
        Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
    } elseif (Test-SparkDashProcess ([int]$raw)) {
        $serverPid = [int]$raw
    } else {
        # Either dead, or the PID was recycled by an unrelated process.
        warn "PID file points at $raw, which is not a running sparkDash server (stale or recycled PID); removing it."
        Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
    }
}

if (-not $serverPid) {
    $owner = Get-PortOwnerPid $PORT
    if ($owner -and (Test-SparkDashProcess $owner)) {
        log "No usable PID file; found this server listening on port $PORT (PID $owner)."
        $serverPid = $owner
    } elseif ($owner) {
        $cmd = Get-ProcCommandLine $owner
        warn "port $PORT is held by PID $owner, which is not a sparkDash server: $cmd"
        log "Nothing to stop here. Free the port yourself, or set PORT=<other>."
        exit 0
    } else {
        if (Test-PortListening $PORT) {
            # Socket present but unnamed, which is what a server started from an elevated console
            # looks like to a non-elevated shell (netstat reports PID 0). Saying "nothing to stop"
            # here was wrong and sent the user looking for a process that is in fact running.
            warn "port $PORT is listening, but its owner PID is not visible to this shell (this is what a server started from an elevated window looks like)."
            log "Run '.\stop.ps1' from that elevated window, or from an administrator shell, to stop it."
            exit 1
        }
        log "No PID file at ${pidFile} and nothing is listening on port ${PORT}: nothing to stop."
        exit 0
    }
}

# Warn if the server is still answering (in-flight probes will be cut off).
$ApiHost = if ($BIND_HOST -in @("0.0.0.0", "::")) { "127.0.0.1" } else { $BIND_HOST }
$URL = "http://${ApiHost}:${PORT}"
try { $null = (Invoke-LocalRest -Uri "$URL/api/health" -Method Get -TimeoutSec 3 -Headers (Get-AuthHeaders $SPARKDASH_TOKEN)) } catch { }

log "Stopping PID $serverPid (up to ${STOP_TIMEOUT}s; kills the process tree)"
& taskkill.exe /PID $serverPid /T /F 2>$null | Out-Null
$waited = 0
while ((Test-PidAlive $serverPid) -and ($waited -lt $STOP_TIMEOUT)) { Start-Sleep -Seconds 1; $waited++ }
if (Test-PidAlive $serverPid) { warn "PID $serverPid did not exit within ${STOP_TIMEOUT}s (check Task Manager)" }
else { log "Stopped PID $serverPid" }
# The socket can still refuse a bind for a couple of seconds after the process is gone; do not
# report "another process holds it" for what is really the tail end of our own shutdown.
for ($i = 0; $i -lt 5 -and (Test-PortListening $PORT); $i++) { Start-Sleep -Seconds 1 }
if (Test-PortListening $PORT) { warn "port $PORT still cannot be bound: another process is holding it (netstat -ano | findstr :$PORT)" }
Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
