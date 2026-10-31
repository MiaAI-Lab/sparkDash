# sparkDash

A self-hosted web dashboard for a fleet of monitored units — NVIDIA DGX Sparks, GPU hosts and Raspberry Pi boards — run by the operator on the machine it monitors.

## Language

**Unit**:
One monitored machine registered in sparkDash, with its own registry entry, poll loop, snapshot and history.
_Avoid_: Spark (when you mean any unit), node, host

**Spark**:
An NVIDIA DGX Spark unit (GB10, unified memory).
_Avoid_: Unit (when you mean this hardware)

**GPU host**:
A non-Spark machine with a supported GPU, monitored for GPU and system metrics.
_Avoid_: Spark, generic host

**Raspberry Pi unit**:
A Raspberry Pi 4/5 board monitored for system health and service presence; it has no supported GPU, no LLM endpoint and no measured input power.
_Avoid_: Pi Spark, Pi node

**Running version**:
The version of sparkDash reported by the server process the browser is talking to.
_Avoid_: Installed version, build version, page version

**Upstream version**:
The version published on the `MiaAI-Lab/sparkDash` `main` branch.
_Avoid_: Latest release, GitHub version

**Update notification**:
A notice in the dashboard that the upstream version is newer than the running version.
_Avoid_: Update alert, upgrade prompt
