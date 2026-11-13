# config.ps1 - shared settings for start.ps1 / stop.ps1 (native Windows 11 ARM64, no Docker, no WSL).
# SPDX-License-Identifier: Apache-2.0
#
# Every value can be overridden from the environment, e.g.
#     $env:PORT = 9000; .\start.ps1
# or by a local ./.env file (KEY=value lines, read here). A value already set in the
# environment wins over .env, which wins over the defaults below. .env is yours, not the repo's.
#
# sparkDash is a pure Node.js app (server + prebuilt React/TS frontend in ./dist). There is no
# Python venv to boot. The one hard requirement is an ARM64-native Node: on this RTX Spark
# machine we use D:\llm\node-arm64 (v22, arm64) - the x64 fallback Node runs under emulated
# x86 on GB10 and is much slower, so prefer the ARM build.

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$RepoRoot  = Split-Path -Parent $ScriptDir

# ---- environment access (duplicates-safe) ----------------------------------------
# Windows PowerShell 5.1's environment provider throws "item with same key" from
# Get-Item / Test-Path when the inherited environment contains two entries differing
# only in case (a common outcome of layered shells). That would abort config.ps1
# before anything runs. [Environment]::GetEnvironmentVariable is case-insensitive and
# never throws on duplicates, so every env read goes through these helpers.
function Read-Env($name) {
    # .env is parsed into a map instead of being written into this process (see the loader below).
    # Precedence: the file wins for the two keys that decide whether the LAN bind is token-gated;
    # for everything else a real environment variable wins, and the file is the fallback.
    $fromFile = $null
    if ($script:EnvFile -and $script:EnvFile.ContainsKey($name)) { $fromFile = $script:EnvFile[$name] }
    $fromProc = [Environment]::GetEnvironmentVariable($name, 'Process')
    if ($name -in @("SPARKDASH_TOKEN", "SPARKDASH_ALLOW_OPEN_REMOTE")) {
        if ($null -ne $fromFile) { return $fromFile }
        return $fromProc
    }
    if ($fromProc) { return $fromProc }
    if ($null -ne $fromFile) { return $fromFile }
    return $null
}
function Get-EnvOr($name, $default) {
    $v = Read-Env $name
    if ((-not $v) -or $v -eq "") { return $default }
    return $v
}

# ---- read ./.env into a map, NOT into this process's environment ------------------------------
# A .ps1 runs inside the caller's console, so a Process-scope write survives the script: that window
# keeps the values, and once .env is edited the stale copy wins over the file. That is exactly how a
# removed token kept gating the page and how an old SPARKDASH_ALLOW_OPEN_REMOTE=0 refused to start.
# Only the launch step copies this map into the child, and it restores the window right after.
$EnvFile = @{}
$EnvFileConflicts = @()
if (Test-Path (Join-Path $RepoRoot ".env")) {
    foreach ($raw in (Get-Content (Join-Path $RepoRoot ".env"))) {
        $line = $raw.Trim()
        if ($line -eq "" -or $line.StartsWith("#")) { continue }
        if ($line -match '^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$') {
            $k = $Matches[1]
            $v = $Matches[2].Trim()
            if ($v -match '^["''](.*)["'']\s*(#.*)?$') { $v = $Matches[1] }
            elseif ($v -match '^(.*?)\s*#.*$') { $v = $Matches[1].Trim() }
            $EnvFile[$k] = $v
            # Record every divergence between a shell variable and the file, masked for secrets; a
            # silent disagreement is what made this impossible to debug from the browser.
            $previous = [Environment]::GetEnvironmentVariable($k, 'Process')
            if ($previous -and $previous -ne $v) {
                $shown = if ($k -like "*TOKEN*") { "length $($previous.Length)" } else { $previous }
                $EnvFileConflicts += "$k (shell=$shown)"
            }
        }
    }
}

# ---- Node runtime ------------------------------------------------------------------
# ARM64-native Node lives in D:\llm\node-arm64. Override with $env:NODE if you keep it elsewhere.
# The arm64 build is the only one that runs natively on GB10; the repo's x64 build falls back
# to emulated x86 and is unusably slow.
$NODE_DEFAULT = "D:\llm\node-arm64\node.exe"
$NODE = Get-EnvOr NODE $NODE_DEFAULT

# ---- endpoint ---------------------------------------------------------------------
# NB: $Host is a read-only automatic variable in PowerShell, so the listen address is BIND_HOST.
$BIND_HOST = if ((Read-Env HOST)) { (Read-Env HOST) } elseif ((Read-Env BIND_HOST)) { (Read-Env BIND_HOST) } else { "127.0.0.1" }
$PORT = Get-EnvOr PORT 5555

# ---- optional integrations (mirror .env.example; all optional) ---------------------
$LLM_PORT    = Get-EnvOr LLM_PORT 8888
$COMFY_PORT  = Get-EnvOr COMFY_PORT 8188
$SPARKDASH_TOKEN = Get-EnvOr SPARKDASH_TOKEN ""
# Open-remote bind (0.0.0.0 / ::) is refused unless SPARKDASH_ALLOW_OPEN_REMOTE=1 AND a token is set.
$SPARKDASH_ALLOW_OPEN_REMOTE = Get-EnvOr SPARKDASH_ALLOW_OPEN_REMOTE "0"

# Windows OpenSSH has no ControlMaster/ControlPath (unix sockets); sparkDash detects this on its own,
# but mirror it here so start.ps1 can surface a warning if the user forced multiplexing on.
$SSH_MULTIPLEX = Get-EnvOr SSH_MULTIPLEX "0"

# ---- runtime files -----------------------------------------------------------------
$RUNTIME_DIR = Get-EnvOr RUNTIME_DIR (Join-Path $RepoRoot ".runtime")

# Timeouts / mode.
$WAIT_TIMEOUT = Get-EnvOr WAIT_TIMEOUT 60     # seconds to wait for /api/health to answer
$STOP_TIMEOUT = Get-EnvOr STOP_TIMEOUT 30     # seconds to let the server shut down
$FOREGROUND   = Get-EnvOr FOREGROUND 0        # 1: stay attached, exit with the server's code

# ---- helpers ------------------------------------------------------------------------
function log($msg)  { Write-Host ("[{0}] {1}" -f (Split-Path -Leaf $MyInvocation.ScriptName), $msg) }
function warn($msg) { Write-Warning ("[{0}] {1}" -f (Split-Path -Leaf $MyInvocation.ScriptName), $msg) }
function die($msg)  { Write-Error ("[{0}] ERROR: {1}" -f (Split-Path -Leaf $MyInvocation.ScriptName), $msg); exit 1 }

# \.start.ps1 runs inside the caller's PowerShell process, so a Process-scope environment write
# outlives the script: it stays in that console window and is inherited by every later run from it.
# That is how a stale SPARKDASH_ALLOW_OPEN_REMOTE=0 survived a .env that says 1 and made start.ps1
# refuse to launch. Snapshot the keys before we touch them and put them back once the child process
# has taken its own copy of the environment.
function Get-EnvSnapshot([string[]]$names) {
    $snap = @{}
    foreach ($n in $names) { $snap[$n] = [Environment]::GetEnvironmentVariable($n, 'Process') }
    return $snap
}
function Restore-EnvSnapshot($snap) {
    if (-not $snap) { return }
    foreach ($k in $snap.Keys) { [Environment]::SetEnvironmentVariable($k, $snap[$k], 'Process') }
}

# Reported here (not inside the loader) because warn() only exists from this point on. Secrets are
# masked; the point is to make a shell/file disagreement visible instead of letting it decide the
# server's behaviour behind the user's back.
if (@($EnvFileConflicts).Count -gt 0) {
    warn ("shell variables differ from .env: " + ($EnvFileConflicts -join "; ") + " - .env wins for SPARKDASH_TOKEN and SPARKDASH_ALLOW_OPEN_REMOTE, other keys keep the shell value")
}

function Test-PidAlive($ProcessId) {
    try { return [bool](Get-Process -Id $ProcessId -ErrorAction Stop) } catch { return $false }
}

# ---- telling *our* server apart from any process that happens to hold the same PID ----
# A live PID proves nothing on Windows: PIDs are recycled, so a stale sparkdash.pid can point at
# an unrelated process (a browser, another node app) and make start.ps1 claim "already running".
# Every PID decision below therefore also checks the command line is our server.
function Get-ProcCommandLine($ProcessId) {
    try {
        $p = Get-CimInstance Win32_Process -Filter "ProcessId=$ProcessId" -ErrorAction Stop
        if ($p) { return $p.CommandLine }
    } catch { }
    return $null
}

function Test-SparkDashProcess($ProcessId) {
    if (-not $ProcessId) { return $false }
    if (-not (Test-PidAlive $ProcessId)) { return $false }
    $cmd = Get-ProcCommandLine $ProcessId
    if (-not $cmd) { return $false }
    # matches both "node server/index.js" and "\"D:\llm\node-arm64\node.exe\" server/index.js"
    return (($cmd -match '(?i)node(\.exe)?(\s|")') -and ($cmd -match '(?i)server[\\/]index\.js'))
}

# The PID listening on $port, or $null. Used as the fallback when no usable PID file exists -
# which is the normal case for a server started by hand or with FOREGROUND=1.
# PID 0 rows are skipped on purpose: they are reserved/system sockets (WinNAT excluded ranges) or
# a listener whose owner the kernel will not name, and they are not a process we could stop.
function Get-PortOwnerPid($port) {
    try {
        $c = @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction Stop | Where-Object { $_.OwningProcess -gt 0 })
        if ($c.Count -gt 0) { return [int]$c[0].OwningProcess }
    } catch { }
    $txt = (netstat.exe -ano 2>$null) -join "`n"
    foreach ($m in [regex]::Matches($txt, ("(?im)^\s*TCP\s+\S+:" + $port + "\s+\S+\s+LISTENING\s+(\d+)"))) {
        $candidate = [int]$m.Groups[1].Value
        if ($candidate -gt 0) { return $candidate }
    }
    return $null
}

function Test-PortListening($port, $bindHost = "0.0.0.0") {
    # Ask the OS by trying to bind, instead of reading the TCP table. Both table-based checks lied on
    # this host: a listener started from an elevated window reports PID 0 (no owner, yet taken), and
    # a listener that was just killed keeps a row that still reads LISTENING for a few seconds while
    # nothing accepts connections (owner, yet dead). A one-shot bind answers the only question
    # start.ps1 actually cares about: would our own bind fail?
    $addr = if ($bindHost -eq "::") { [System.Net.IPAddress]::IPv6Any } elseif ($bindHost -and $bindHost -ne "0.0.0.0") { [System.Net.IPAddress]::Parse($bindHost) } else { [System.Net.IPAddress]::Any }
    $listener = $null
    try {
        $listener = [System.Net.Sockets.TcpListener]::new($addr, $port)
        $listener.Start()
        return $false          # we got the port: nothing is listening
    } catch {
        return $true           # someone else holds it
    } finally {
        if ($listener) { try { $listener.Stop() } catch { } }
    }
}

# Identify what is serving a port when the kernel will not name the owner. A server started from an
# elevated console reports OwningProcess = 0 to a non-elevated shell, so the port looks occupied by
# "nobody" even though it is our own server answering requests. /api/auth/status is the one endpoint
# that answers before token auth (server/index.js registers it just above createAuthMiddleware), so
# it identifies the app in every bind mode; the tokenRequired field is sparkDash's own shape.
function Test-SparkDashHttp($url, $token) {
    try {
        $r = Invoke-LocalRest -Uri "$url/api/auth/status" -Method Get -TimeoutSec 4 -Headers (Get-AuthHeaders $token)
        if ($null -ne $r -and $null -ne $r.tokenRequired) { return $true }
    } catch { }
    return $false
}

function Test-ApiReady($url) {
    # A token-gated bind (BIND_HOST != loopback) also gates /api/health: without the bearer header
    # the probe gets 401, and start.ps1 would wait out WAIT_TIMEOUT on a perfectly healthy server.
    try { $null = Invoke-LocalRest -Uri "$url/api/health" -Method Get -TimeoutSec 5 -Headers (Get-AuthHeaders $SPARKDASH_TOKEN); return $true } catch { return $false }
}

# The Authorization header for server calls made by these scripts. Empty for a loopback bind
# (nothing to authenticate), the bearer token otherwise.
function Get-AuthHeaders($token) {
    if ($token) { return @{ Authorization = "Bearer $token" } }
    return @{}
}

# Windows PowerShell 5.1 portability: Invoke-RestMethod's default verb is POST there (GET only from
# 6.0), and -NoProxy does not exist. Always pass -Method explicitly; clear the default proxy for
# loopback calls. Linux/PS7 behaviour is unchanged.
function Invoke-LocalRest {
    param([string]$Uri, [int]$TimeoutSec = 5, [string]$Method = 'Get', [string]$Body = $null, [hashtable]$Headers = $null)
    $h = if ($Headers -and $Headers.Count -gt 0) { $Headers } else { $null }
    if ($PSVersionTable.PSVersion.Major -ge 6) {
        if (-not [string]::IsNullOrEmpty($Body)) {
            return Invoke-RestMethod -Uri $Uri -Method $Method -ContentType 'application/json' -Body $Body -TimeoutSec $TimeoutSec -NoProxy -ErrorAction Stop -Headers $h
        }
        return Invoke-RestMethod -Uri $Uri -Method $Method -TimeoutSec $TimeoutSec -NoProxy -ErrorAction Stop -Headers $h
    }
    $old = [System.Net.WebRequest]::DefaultWebProxy
    [System.Net.WebRequest]::DefaultWebProxy = $null
    try {
        if (-not [string]::IsNullOrEmpty($Body)) {
            return Invoke-RestMethod -Uri $Uri -Method $Method -ContentType 'application/json' -Body $Body -TimeoutSec $TimeoutSec -ErrorAction Stop -Headers $h
        }
        return Invoke-RestMethod -Uri $Uri -Method $Method -TimeoutSec $TimeoutSec -ErrorAction Stop -Headers $h
    } finally { [System.Net.WebRequest]::DefaultWebProxy = $old }
}
