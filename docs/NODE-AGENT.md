# Node agent: read Linux units without SSH polling

By default sparkDash reads a remote Linux unit by running about five shell commands over SSH every 2 s. Where each command becomes a login session on the unit (observed with Tailscale SSH), that churn is not free: on DGX Spark the session bookkeeping made `polkitd` grow by about 1 GiB a day, and on a GB10 that memory is the GPU's memory too.

`sparkdash-agent` (source in [`agent/`](../agent/README.md)) is an optional, read-only service for such a unit. It reads `/proc`, `/sys` and NVML in-process, keeps no GPU memory, runs no commands, and answers one token-gated `GET /v1/snapshot` per poll. The dashboard turns that document into the same metrics, by the same parsing rules, as the SSH path.

It is opt-in per unit. A unit without an `agent` block is read over SSH exactly as before.

## Enable it for a unit

1. Build or download the binary for the unit's architecture and install it there (see [agent/README.md](../agent/README.md)):

   ```sh
   sudo ./install.sh --listen 192.0.2.10:9110 --allow 192.0.2.0/24
   ```

   The installer prints the bearer token it generated (or keeps the existing one in `/etc/sparkdash-agent/token`).

2. Give sparkDash the token, in `.env` (Docker) or the server's environment:

   ```sh
   SPARKDASH_AGENT_TOKEN=<token>
   ```

   One token is used for every agent unit, so install the same token on each (`install.sh --token-file`).

3. Add the agent to the unit in `config/sparks.json` and restart sparkDash:

   ```json
   { "id": "spark-a", "lanIp": "192.0.2.10", "agent": { "url": "http://192.0.2.10:9110" }, "ssh": { "host": "192.0.2.10", "user": "me" } }
   ```

The agent URL can only be set in `config/sparks.json`. The dashboard sends the token to it, so the HTTP API and the Edit dialog cannot set or change it.

## What comes from the agent

GPU (NVIDIA through NVML: temperature, utilisation, power and limit, SM clocks, throttle reasons, fan, PCIe link, compute processes), CPU usage and temperature, RAM and unified memory, local disks and I/O rates, network interfaces, default route, addresses and link speeds, the Wake-on-LAN MAC, RoCE link state and RDMA counters, uptime and liveness, hardware detection, the `nvidia-smi -lgc` clock-cap marker in `/run/sparkdash/`, and the kernel's `NV_ERR_NO_MEMORY`, Xid and OOM-kill counts (from `/dev/kmsg`).

Rates and percentages are computed by the dashboard from the agent's raw counters, as they are for SSH units. A value the agent could not read stays unknown; it is never reported as zero.

The kernel counts are since-boot totals only when the agent has seen the whole boot: it replays the kernel's ring buffer when it starts, and if that buffer has already wrapped, the counts read unknown until the next reboot (the installed unit starts at boot, so this applies after a mid-boot install or restart). Reading `/dev/kmsg` needs `CAP_SYSLOG`, which the systemd unit grants; without it the counts are unknown. The SSH path reads the systemd journal instead, which can also have lost the start of a long boot to rotation.

## Fallback

There is none, on purpose. If the agent does not answer, the unit shows offline with the reason (`node agent: connection refused`, `node agent: answered HTTP 401 (check SPARKDASH_AGENT_TOKEN)`, …). Falling back to SSH would quietly bring back the session churn the agent removes, and hide that the agent is down. Remove the `agent` block to go back to SSH polling.

## What still uses SSH

Only on-demand actions and opt-in probes: Shutdown, model launchers, GPU clock and power-limit changes, the Storage Manager, benchmark tunnels, and the Hermes, Tailnet and spark-attic probes. Leave those probes off on agent units to keep them free of periodic sessions.

Not available on agent units for now: resident vLLM model discovery (it needs Docker access on the unit), the RoCE panel's `ethtool`/`mlnx_qos` details (discards, CRC errors, pause frames, PFC and trust; link state, rates and RDMA counters are shown), AMD and Intel GPUs (the agent reads NVIDIA through NVML; such hosts stay on SSH), and the clock-cap marker in the SSH user's home directory.
