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

## Runtime control

The user agent can start and stop a catalogued runtime. It does not grow a second
daemon: the same `--serve` process answers `/control`. The privileged root
collector refuses these routes (`python3 -I` does not even load the control
module; if it did, uid 0 still returns permission denied).

Control is **off** until both sides share a token. Set
`SPARKDASH_MAC_CONTROL_TOKEN` in the user agent's LaunchAgent environment and
in the sparkDash server environment. Until then the dashboard tile says
unavailable and does not offer a launch button. A wrong token is permission
denied, and the command is not run.

| method | path | effect |
| ------ | ---- | ------ |
| GET | `/control` | catalog plus what a process/port probe sees serving. Runs no start command. |
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
