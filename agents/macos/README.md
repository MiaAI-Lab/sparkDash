# sparkDash Mac node agent

A small collector that turns an Apple Silicon Mac into a sparkDash node: system
vitals plus an honest picture of which local model runtime, if any, is serving.

- **stdlib only.** Runs on the system `python3`. `psutil` is used when present
  (per-core CPU detail) and never required, so there is nothing to `pip install`.
- **Nothing invented.** Missing readings are declared in `unavailable` with a
  reason, so the dashboard renders "unavailable" instead of a convincing zero.
  See [power](#unlocking-gpu-and-ane-power) and
  [temperature](#opt-in-root-temperatures) collection for privilege requirements.
- **Nothing hardcoded about the engines.** Which runtimes exist, their ports, how
  to recognise them, and how to read the served model out of argv all come from
  [`runtimes.json`](runtimes.json). A Python server that is not in the inventory
  shows up as `other-runtime` with its own command basename rather than being
  folded into an engine it merely resembles.

## Run it

```bash
python3 agents/macos/sparkdash_mac_agent.py --once --pretty   # one snapshot to stdout
python3 agents/macos/sparkdash_mac_agent.py --serve --port 8790   # HTTP: /metrics, /health
python3 agents/macos/sparkdash_mac_agent.py --once --config my-runtimes.json
```

`GET /metrics` returns the snapshot; `GET /health` is a cheap liveness answer.
`GET /control` lists launch targets and the serving probe. `POST /control/start`
and `POST /control/stop` are the only paths that run a command, and only when
`SPARKDASH_MAC_CONTROL_TOKEN` matches. See [Runtime control](#runtime-control).
Samples are shared for two seconds (`SAMPLE_TTL_S`) so a fast poll loop costs one
`iostat` + one `lsof`, not one per request.
While the first sample is pending, `/metrics` returns HTTP 503 without telemetry.
A slow refresh retains one worker and publishes its result when it finishes;
previous samples include `sampleAgeSeconds` and `sampleStale`.

A valid agent snapshot owns all system reads, including uptime and hardware
metadata. Missing uptime or hardware metadata does not trigger SSH fallback;
fallback is used only when the agent cannot supply a valid snapshot, including
HTTP 503 during initial collection.

## Install as a LaunchAgent (one line)

```bash
sed "s|/Users/PLACEHOLDER|$HOME|g; s|REPOS/sparkDash|$(pwd)|" agents/macos/ai.onyx.sparkdash-mac-agent.plist > ~/Library/LaunchAgents/ai.onyx.sparkdash-mac-agent.plist && launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ai.onyx.sparkdash-mac-agent.plist
```

Run from the sparkDash checkout, after editing the plist's `--host`/`--port` if
the defaults (bind all interfaces, port 8790 — no credentials, so keep it on a
trusted LAN or tailnet) are wrong for you. Then add the unit in sparkDash with
**Unit type → Apple Silicon Mac** and a **Mac node agent** port of 8790.

Stop it with `launchctl bootout gui/$(id -u)/ai.onyx.sparkdash-mac-agent`.

### Unlocking GPU and ANE power

Run the agent as root and it samples `powermetrics` itself. The opt-in
LaunchDaemon below does that. Until then `gpu.utilization`, `gpu.power` and
`ane.power` stay declared-unavailable, which is what the dashboard is built to
show. `--powermetrics` still attempts `sudo -n powermetrics` from a user
process for those power counters only; it does not publish temperatures.

### Opt-in root temperatures

Installing the privileged collector is a deliberate step. It is not started by
the user-agent install, and that install is left untouched.

```bash
agents/macos/install-privileged-collector.sh
agents/macos/uninstall-privileged-collector.sh
```

An ordinary user runs either command. `sudo` prompts to copy the LaunchDaemon
plist to `/Library/LaunchDaemons/` and to bootstrap or bootout
`ai.onyx.sparkdash-mac-agent.privileged`. The user LaunchAgent
(`ai.onyx.sparkdash-mac-agent`, port 8790) is not modified, stopped, or
replaced. The daemon listens on `127.0.0.1:8791` so the install does not open
another LAN port. Point the sparkDash Mac node agent port at 8791 to read
temperatures. A dashboard on another host cannot reach this loopback listener
by changing the port alone. Edit the installed plist's `--host` only if a remote
dashboard must scrape it; that is the same unauthenticated `/metrics` trust
model as the user agent. An authorized launchd reload is needed for the new bind
address to take effect; reinstalling restores the checked-in template's address.

Installation copies only `sparkdash_mac_agent.py` and `runtimes.json` into
`/Library/Application Support/ai.onyx.sparkdash-mac-agent`, owned by root:wheel
and writable only by root. It refuses unprotected or symlinked parent
directories. The daemon uses isolated Python imports and runs the protected
copy, so checkout edits require another authorized installation to take effect.
Uninstall confirms that the daemon is absent before deleting its plist; the
protected collector files and logs remain on disk. Authentication or service
inspection errors stop either script before changing the service.
Elevated runtime detection remains limited to the console user's processes;
without a console user it reports no runtimes. Agent processes are excluded.

Security: the daemon runs as root so it can read hardware counters. It reads
`powermetrics` text and, when a CPU or GPU die-temperature reading is missing,
falls back to AppleSMC temperature keys
(`Tp`/`Te`/`Ts` for CPU, `Tg` for GPU). CPU and GPU temperatures are published in
Celsius only when measured by an elevated agent; otherwise they remain null
with an unavailable reason. The agent's thermal-pressure row summarizes **last
recorded** `pmset -g therm` warnings (nominal, slow, trapped, or unknown, with
event lines), rather than a live temperature. SSH fallback instead uses the
`powermetrics` pressure label described in [Mac units](../../README.md#mac-units).
The daemon does not write hardware state. It exposes a separate read-only
metrics listener on the loopback address above. Every external command the agent
runs has a hard timeout, so one stuck probe cannot wedge `/metrics`.

## Runtime inventory

`runtimes.json` is a list of entries, evaluated top to bottom, first match wins —
so a model-specific variant (`splash-35b`) is listed before its catch-all parent
(`splash`). Each entry may use:

| key           | meaning                                                                 |
| ------------- | ----------------------------------------------------------------------- |
| `name`        | reported runtime name                                                    |
| `label`       | display label (defaults to `name`)                                       |
| `ports`       | listener ports the engine is expected to own; no match → not reported    |
| `exe`         | regex against the process command basename and, for interpreters, the script being run |
| `argvAll`     | regexes that must all match the full command line                        |
| `role`        | `server` (default) or `watchdog` (a launcher: reported as `running`)     |
| `health`      | `{path, timeoutMs}` GET on loopback that proves "serving" (default `/v1/models`) |
| `model`       | `{flags, positional}` — how to read the served model out of argv         |

Anything matched by an entry is claimed by it. Among the eligible processes
described in [elevated-process privacy rules](#opt-in-root-temperatures), every
remaining TCP listener owned by a Python-ish process is reported once as
`other-runtime`.

The shipped file is seeded from the captain's `model-start()` shell functions
(`omlx`, `qflash`, `splash` + `-27b`/`-35b`, `ds4`, `ds4-serve`, `mtplx` +
`-27b`/`-35b`/`-flash`, the `:8200` MTPLX mux, and `tensorfold`). Copy it, edit
it, and point `--config` at your own — the agent has no built-in engine names.

## Storage categories

Set `"storageCategories": true` at the top level of `runtimes.json` (default off)
or pass `--storage-categories` (including via
`agents/macos/install-privileged-collector.sh --storage-categories`, which also
preserves any existing `storageCategories` setting in the installed
`runtimes.json` on reinstall) and the agent adds an Apple-style category
breakdown — Applications, Developer, Documents, Photos, Media, Mail, Messages,
iCloud Drive, iOS Files, Trash — to its disk report, scanned roughly every 15
minutes (failed scans retry after 60 seconds).

Documents follows Apple's own definition ("files from your home folder that
aren't in another category"): a residual of the target home directory minus
Applications, Developer, Library, media folders and the Trash, so the bar
spreads out like the System Settings storage bar instead of collapsing into a
sliver. Directories on a different physical volume (`st_dev`) are not attributed
to the internal volume, and when the root daemon runs on a headless machine with
no logged-in console user (and no explicit `home` configured), internal-volume
categories are omitted rather than scanning `/var/root`. Everything the scan
cannot attribute stays honest as a "System Data" residual (`df` used minus the
measured categories), so an unknown layout is never presented as measured.

An object form is also supported when a host places data outside the defaults:

```json
"storageCategories": {
  "enabled": true,
  "home": "/Users/alice",
  "externalVolumes": true,
  "excludeVolumes": ["/Volumes/TimeMachine"],
  "extraPaths": {
    "developer": ["/opt/homebrew"],
    "models": ["/Volumes/SSD/models"]
  }
}
```

External SSDs get the same treatment when enabled: every mounted local writable
volume under `/Volumes` (real `/dev/disk*` filesystems only — network mounts,
read-only disk images such as `.dmg` installers, and Time Machine stores
containing `Backups.backupdb` are skipped) is scanned alongside the primary
volume, with the same categories rooted at the mount point and `.Trashes` as
that drive's trash. A drive that is plugged in shows a segmented bar; unplug it
and the bar is gone; a drive without Pictures or Developer simply reports fewer
segments.

A few of those directories are TCC-protected: a daemon without **Full Disk
Access** sees `Operation not permitted` on Documents, Desktop, Downloads, the
Trash and the photo library. Run:

```bash
/usr/bin/python3 "/Library/Application Support/ai.onyx.sparkdash-mac-agent/sparkdash_mac_agent.py" --setup-fda
```

to locate the branded **`SparkDash Mac Agent.app`** (`ai.onyx.sparkdash-mac-agent`,
created automatically by `install-privileged-collector.sh --storage-categories`
with the SparkDash icon inside `/Library/Application Support/ai.onyx.sparkdash-mac-agent/`,
or falling back to the outermost `.app` bundle / interpreter binary), check folder
access, and open Finder + System Settings → Privacy & Security → Full Disk Access,
or leave it off — restricted categories keep their partial lower bounds, carry a
`restricted` flag, and the dashboard marks them with a hatch pattern and an
asterisk (`*`) while any unread bytes continue to appear inside the `System Data`
residual. Launching via `SparkDash Mac Agent.app` ensures every Mac grants Full
Disk Access to one clearly named app instead of `Xcode.app`, `Python.app`, or CLI
shims, and preserves its code-signature hash (`cdhash`) across `sparkdash_mac_agent.py`
updates.

## Runtime control

The user agent can start and stop a catalogued runtime. It does not grow a second
daemon: the same `--serve` process answers `/control`. The privileged root
collector refuses these routes (`python3 -I` does not even load the control
module; if it did, uid 0 still returns permission denied).

Control is **off** until both sides share a token. Set
`SPARKDASH_MAC_CONTROL_TOKEN` in the user agent's LaunchAgent environment and
in the sparkDash server environment. Until then the dashboard tile says
unavailable and does not offer a launch button. A wrong token is permission
denied on both status and action requests, and the command is not run. If process or listener inventory cannot be read, serving state remains unknown and launch is blocked.

| method | path | effect |
| ------ | ---- | ------ |
| GET | `/control` | authenticated catalog and current serving probe. Runs no start command. |
| POST | `/control/start` | runs that target's catalog `start` argv. Body: `{"runtime","model"}`. |
| POST | `/control/stop` | runs that target's catalog `stop` argv. |

The request names a catalog entry. It is not interpolated into the command.
The shipped [`control.json`](control.json) mirrors `model-start` / `model-stop`
on the captain's Mac by sourcing `~/.zshrc` and calling those functions, including
their mutual exclusion. A machine without those functions gets the shell's real
error on the tile; the tile does not turn green because a command exited.

`/metrics` is unchanged. A control request does not refresh or rewrite the
metrics sample, and a slow start command does not hold `/metrics`.

## Tests

```bash
python3 -m unittest discover -s agents/macos/tests
```

They reuse the SSH collector's macOS fixtures, so both transports are asserted to
produce the same unified-memory and powermetrics numbers from the same capture.

### Verified model profiles

The launcher selects an explicit runtime/model profile. `control.json` contains
only allowlisted commands; per-model `start` argv is supported when a target has
multiple models. Ambiguous multi-model commands are refused. Actions serialize,
and a concurrent switch is refused rather than queued for an unexpected later
model change. `timeoutSeconds` may be set between 10 and 600 for cold startup.

`profile_runner.py --profiles PATH --inventory PATH start|stop PROFILE` owns the
single heavy-model slot. Its private, current-user-owned `0600` JSON file defines
`stop` (an absolute argv) and a `profiles` object. Each named profile declares
`argv`, `port`, exact API `model`, `requiredPaths`, `readyTimeout` (up to 300
seconds), and optional `warmup`. Validate binaries and cached paths before
stopping the current engine. The stop command must stop supervisors as well as
servers; the Mac's `model-stop-all` avoids `model-stop`'s TensorFold auto-reclaim
path. The runner waits for the old processes and model listeners to disappear,
then detaches the selected server and verifies its exact `/v1/models` ID.
Optional warmup loads the selected model and checks one-token inference.
The MTPLX mux and dedicated VoiceInk/Bonsai service remain outside the heavy slot.
A failed launch reports an error and cleans its own process tree; it does not
silently restore or start another model. Logs are private files under the user's
cache. Adding a profile does not install or download models.

Keep privileged telemetry separate: configure a Mac agent with `port: 8791` and
`controlPort: 8790` when those are its actual telemetry and user-control ports.
The control endpoint uses the same configured host and optional URL, with only
the port overridden. Keep the user listener on loopback and use a private tailnet
forward for remote access. Root collectors still cannot launch runtimes.

Set the same `SPARKDASH_MAC_CONTROL_TOKEN` on the user agent and dashboard.
Alternatively, the dashboard reads `SPARKDASH_MAC_CONTROL_TOKEN_FILE` or
`config/mac-control-token`; the file must be regular, not a symlink, owned by the
server UID, and have no group/world permissions. It is never sent to the browser.
Control POSTs without the correct token are denied. Status GETs never execute
commands. Protect the LaunchAgent plist containing the agent token with `0600`.

Profiles that use authenticated APIs can set `apiKeyFile` to an absolute,
private current-user-owned `0600` file. Its value is used only in loopback
Authorization headers. For oMLX, use a profile-specific `--base-path` when
launch arguments must not change the existing server settings. Use the API
model ID in the profile, which may differ from its Hugging Face repository ID.

For an authenticated runtime's inventory health check, set its optional
`health.apiKeyFile` to that private key file and use `path: "/v1/models"`.
This requires `profile_runner.py` alongside the user agent; unavailable or unsafe
key files leave health unavailable. Keys never appear in metrics. The native
oMLX `omlx-server` process and current MTPLX module server are recognized even
when their launcher changes its process title. The stop helper is followed by
an inventory-owned, same-UID stop fallback; unknown processes are never signaled.
All captured PIDs must disappear before another profile starts. An argv change
or ambiguous PID reuse does not count as proof of memory release.

### Long starts and operation status

The dashboard submits start/stop once and returns HTTP202 while it runs. It
polls the agent's read-only control status instead of holding the browser's
connection open through model loading. `busy` and the current/latest UUID
`operation` come from the Mac's action lock, so losing the dashboard connection
does not imply the engine stopped. Controls remain locked while the operation
is unresolved. Polling never starts, stops, or retries a model. A completed
operation carries its actual success/error and command output; a failed HTTP
submission is reconciled against authoritative status before another action.
Agent-backed Macs use the dashboard's Models panel for these profiles. Its output
viewer follows authenticated operation snapshots (the newest 4,000 characters),
including stopping, memory release, startup, exact-model readiness and warmup.
Copy, expand and the saved output preference use the same viewer as script
models. Full engine logs remain in the private log path reported on completion.
Unauthenticated status reads do not expose the current or last operation output.
A wrapper timeout sends TERM and allows 60 seconds for owned-tree cleanup before
KILL; long agent requests also use explicit HTTP header/body timeouts.
