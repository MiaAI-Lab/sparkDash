# run-persistent.ps1 - helper for background/autostart contexts.
# SPDX-License-Identifier: Apache-2.0
#
# start.ps1's daemon lives in the launching console's process group: it persists while that
# console stays open and stops when it closes (the same behaviour as the TensorFold start.ps1
# on this box). Run start.ps1 from a normal interactive console to use the dashboard the usual
# way. This wrapper exists for NON-interactive contexts (a scheduled task, a boot script, or
# a background job) where there is no human keeping a console open: it runs start.ps1 and then
# holds the process open, so the daemon keeps serving until this wrapper is stopped.
#
#   .\scripts\run-persistent.ps1            start and keep the daemon alive
#   .\scripts\run-persistent.ps1 restart    restart, then keep alive
# Stop the daemon:  .\stop.ps1   (or stop this wrapper's process tree)

$MyDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
. (Join-Path $MyDir "config.ps1")
& (Join-Path $MyDir "..\start.ps1") @args
$rc = $LASTEXITCODE
if ($rc -ne 0) { exit $rc }
# start.ps1 succeeded (or the daemon was already running). Hold this process open so the
# daemon's process group stays alive in a non-interactive context. stop.ps1 kills the daemon;
# this wrapper then exits on its next check.
Write-Host "[run-persistent] daemon serving; this wrapper holds the process open. Stop with .\stop.ps1"
while ($true) {
    $pidFile = Join-Path $RUNTIME_DIR "sparkdash.pid"
    $alive = $false
    if (Test-Path $pidFile) {
        $p = (Get-Content $pidFile -Raw).Trim()
        if ($p -match '^\d+$') { $alive = try { [bool](Get-Process -Id ([int]$p) -EA Stop) } catch { $false } }
    }
    if (-not $alive) { Write-Host "[run-persistent] daemon no longer running; exiting."; break }
    Start-Sleep -Seconds 5
}
exit 0
