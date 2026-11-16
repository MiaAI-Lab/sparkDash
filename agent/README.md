# sparkdash-agent

A small read-only metrics agent for the hosts sparkDash monitors. sparkDash reads each host with one HTTP GET per poll instead of running shell commands over SSH.

## Why

Without the agent, sparkDash polls every unit with about five SSH commands every 2 s (`cat /proc/…`, `nvidia-smi`, `df`, `ip addr`). Over Tailscale SSH every command is a new login session, and on DGX Spark that session churn made polkitd grow by about 1 GiB a day. On GB10 that memory is shared with the GPU.

The agent reads the same data in-process. It opens no sessions, spawns no processes, runs no commands and holds no GPU memory. It uses only std threads, `serde`, `libc` and `nvml-wrapper`.

Footprint, measured with dashboard-shaped polling (a snapshot every 2 s, `/v1/rdma` every 6 s):

| Host | Peak RSS | CPU | Snapshot time |
| --- | --- | --- | --- |
| DGX Spark (GB10), NVML loaded, 4 RoCE ports | 21.5 MB (15 MB of it is NVML's own state) | 0.56 % of one core | 20–30 ms (`/v1/rdma`: about 160 ms) |
| x86_64 host without a GPU | 3.4 MB | 0.15 % of one core | under 5 ms |

Loading NVML maps `libcuda` but creates no CUDA context: no compute process appears in `nvidia-smi`. Release binaries are about 650–760 KB.

## What it reads

| Data | Source |
| --- | --- |
| Hostname, kernel release, boot id, uptime | `/proc/sys/kernel/{hostname,osrelease,random/boot_id}`, `/proc/uptime` |
| CPU model, cores, jiffies, load | `/proc/cpuinfo`, `/proc/stat`, `/proc/loadavg` |
| CPU temperatures | hwmon `coretemp`/`k10temp`/`zenpower`/`acpitz`/`soc_thermal`, then every thermal zone |
| Memory and swap | `/proc/meminfo` |
| GPU name, UUID, utilization, temperature, power and limit, SM clocks, fan, PCIe link, memory, throttle reasons, compute processes | NVML (`libnvidia-ml.so.1`, loaded once, no CUDA context) |
| GPU clock-cap marker | first line of `/run/sparkdash/gpu-clock-cap`, if present |
| `NV_ERR_NO_MEMORY`, Xid and OOM-kill counts | `/dev/kmsg`: the ring buffer is replayed once, then a thread blocks on new records |
| Local filesystems | `/proc/mounts` + `statvfs` (block devices only; network filesystems are never touched) |
| Block device I/O | `/sys/block/*/stat` |
| Interfaces, default route, IPv4, operstate, speed, MAC | `/proc/net/dev`, `/proc/net/route`, `getifaddrs`, `/sys/class/net` |
| RDMA/RoCE port state, rate, counters (`/v1/rdma`) | `/sys/class/infiniband/*/ports/1` and the port's netdev (RoCE traffic never shows in `/proc/net/dev`) |

Samples are taken on demand and cached for at least `--min-interval-ms` (1 s minimum). The host is read at most once per interval however many dashboards poll, and not at all when nobody asks.

## API

- `GET /healthz`: `ok`, no token.
- `GET /v1/snapshot`: the metrics document, schema `sparkdash.node-agent/1`. Needs `Authorization: Bearer <token>`. The `Snapshot` struct in [`src/sampler.rs`](src/sampler.rs) is the contract. Unknown values are `null`, never 0.

- `GET /v1/rdma`: RDMA/RoCE port state, rate, `hw_counters` and payload counters, plus the ports' netdev statistics. Same token. It is a separate route because on mlx5 every `hw_counters` read is a firmware query (2–3 ms each, about 130 per sample on a DGX Spark), which the dashboard needs only every few seconds; it is cached for the same minimum interval.

Unknown paths get 404. Another method on a known path gets 405 with `Allow`, and a missing or wrong token gets 401.

## Security

- The agent binds only the addresses given with `--listen` and refuses `0.0.0.0`/`::`. Peers outside the `--allow` CIDRs are dropped before any byte is read.
- The token (at least 24 characters) comes from a systemd credential (`/etc/sparkdash-agent/token`, mode 0600) and is compared in constant time.
- One request per connection: 8 KiB head limit, per-route body limit, 2 s IO timeouts and a 5 s deadline per request.
- Under systemd it runs as a `DynamicUser` with only `CAP_SYSLOG` (for `/dev/kmsg`), `ProtectSystem=strict`, `ProtectHome=read-only`, a syscall filter, `MemoryMax=64M`, `CPUQuota=5%` and `TasksMax=8`.

## Build

```sh
agent/build.sh [aarch64|x86_64|all]    # -> agent/dist/sparkdash-agent-<arch>-linux
```

The build runs in Docker on Debian bullseye (glibc 2.31), so the binaries run on Ubuntu 20.04, 22.04 and 24.04 and on DGX OS. A foreign architecture is built under qemu (`docker run --platform` must work). The binaries link only glibc dynamically. NVML has to be `dlopen()`ed from the driver install, so a static musl build is not an option.

## Install

Copy the binary for the host's architecture, `deploy/install.sh` and `deploy/sparkdash-agent.service` to one directory on the host, rename the binary to `sparkdash-agent`, and run:

```sh
sudo ./install.sh --listen 192.0.2.10:9110 --allow 192.0.2.0/24 [--token-file ./token] [--binary PATH]
```

The script installs `/usr/local/bin/sparkdash-agent` and the unit, writes `/etc/sparkdash-agent/agent.env` if it is missing (see `deploy/agent.env.example`), then enables and restarts the service. `--token-file` installs an existing token, so several hosts can share one dashboard token. Without it, a token is generated once and printed. Run the script again to upgrade; an existing `agent.env` is kept.

## Enable in sparkDash

Set the agent URL on the unit in `config/sparks.json`:

```json
"agent": { "url": "http://192.0.2.10:9110" }
```

Then put the token in sparkDash's environment as `SPARKDASH_AGENT_TOKEN`. See [docs/NODE-AGENT.md](../docs/NODE-AGENT.md).

## Clipboard sync

Built with `--features clipboard`, the same binary has a second, opt-in mode that keeps a desktop's OS clipboard in step with the dashboard's shared clipboard (Settings → Shared clipboard; [docs/CLIPBOARD.md](../docs/CLIPBOARD.md)). It runs in the user's desktop session, not in the metrics service, and does nothing until it is started:

```sh
sparkdash-agent clipboard --dashboard http://192.0.2.20:5555 [--token-file PATH] [--device NAME]
```

- A copy on the desktop (text, an image, or files from a file manager) becomes the shared clipboard's latest entry. A new shared entry from a browser or another desktop lands on this desktop's clipboard; files are saved under the user's cache directory (`sparkdash-clipboard/`, the newest 10 entries kept) and offered as file references.
- Clipboard backends: Wayland compositors with the data-control protocol (wlroots compositors such as Hyprland and Sway, and KDE Plasma), X11, macOS and Windows. GNOME on Wayland lacks data-control; there it falls back to X11 through XWayland when `DISPLAY` is set. A machine with no desktop session (a headless Spark) logs that there is nothing to sync and exits 0.
- What is on the clipboard at start is never sent, and the shared clipboard's current entry is not applied at start; only new copies move. A copy this desktop made is not applied back to it, and writing a shared entry to the clipboard is not mistaken for a new local copy.
- Copies that password managers mark as secret are skipped (`x-kde-passwordManagerHint` on Wayland, `org.nspasteboard.ConcealedType` on macOS, `ExcludeClipboardContentFromMonitorProcessing` on Windows).
- The token is the dashboard's `SPARKDASH_TOKEN`, read from `--token-file` or from `sparkdash-agent/token` in the user's config directory when that file exists. A dashboard without a token answers the clipboard only on its own loopback address.
- Errors back off: `404` (the dashboard's clipboard is off), `401` and `403` wait a minute; network errors wait 2 s doubling to a minute. Copies over the dashboard's limits are skipped.

Footprint, measured on an x86_64 Wayland (Hyprland) desktop: 4.6–5 MB RSS idle, about 0.03% of one core (20 ms of CPU a minute, checking every second), two threads. With an 8 MB screenshot left on the clipboard, about 0.3% of a core and 4.8 MB steady (12.7 MB peak while it uploads). macOS and Windows read the clipboard only when their change counter moves. The binary grows to about 3.3 MB, so build the metrics service without the feature (`agent/build.sh` does unless `FEATURES=clipboard`); the metrics service is unchanged either way.

Run it at login:

- Linux (systemd user session): `deploy/sparkdash-agent-clipboard.service` with `deploy/clipboard.env.example` as `~/.config/sparkdash-agent/clipboard.env`, then `systemctl --user enable --now sparkdash-agent-clipboard`. The session must export `WAYLAND_DISPLAY` or `DISPLAY` to systemd (most desktops do; otherwise `systemctl --user import-environment WAYLAND_DISPLAY DISPLAY`).
- macOS: `deploy/net.sparkdash.agent-clipboard.plist` in `~/Library/LaunchAgents/`.
- Windows: build with `cargo build --release --features clipboard` and start `sparkdash-agent.exe clipboard --dashboard …` from the Startup folder or a Task Scheduler logon task.

## Uninstall

```sh
sudo ./install.sh --uninstall
```

This stops and disables the service and removes the binary, the unit and `/etc/sparkdash-agent`.

## Develop

```sh
cd agent
cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test
cargo clippy --all-targets --features clipboard -- -D warnings && cargo test --features clipboard
cargo run -- --listen 127.0.0.1:9110 --token-file /path/to/token
curl -H "Authorization: Bearer $(cat /path/to/token)" http://127.0.0.1:9110/v1/snapshot
```

The parsers and sysfs readers are tested against fixtures and temporary directory trees. Without a GPU, `gpus` is empty and `gpuError` says why. Without `CAP_SYSLOG`, `kernelLog` is null.
