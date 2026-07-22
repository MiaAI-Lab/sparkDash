#!/bin/bash
# Host-side GPU memory helper for DGX Spark (GB10) and Docker deployments.
#
# Why this exists
# ---------------
# On GB10, nvidia-smi memory.used / memory.total are often [N/A] (unified HBM).
# "Used by GPU" is better taken from compute-apps. Inside Docker, compute-apps
# can also be empty or hard to correlate (PID namespace / partial driver mounts),
# so the Node collector may not see processes. This script runs on the *host*
# and writes a small JSON file the container reads via the ./config bind mount.
#
# Install (example) — optional backup when the container does *not* use `pid: host`
# --------------------------------------------------------------------
# With docker-compose `pid: host`, sparkDash reads compute-apps live each poll.
# Keep this cron only as a fallback (e.g. older compose without pid: host):
#   chmod +x /path/to/sparkDash/config/gpu-memory.sh
#   * * * * * /path/to/sparkDash/config/gpu-memory.sh
#
# Output path (first match wins)
# ------------------------------
#   1) $SPARKDASH_GPU_MEMORY_JSON
#   2) $SPARKDASH_CONFIG/gpu-memory.json
#   3) <directory of this script>/gpu-memory.json  (default with ./config mount)
#
# JSON shape
# ----------
#   {
#     "used": <MB, sum of compute-apps used_gpu_memory>,
#     "total": <MB, MemTotal from /proc/meminfo — unified pool size on GB10>,
#     "processes": [ { "pid", "name", "vramMB" }, ... ],
#     "timestamp": <unix seconds>
#   }
#
# "total" is OS MemTotal (unified pool), not discrete VRAM. The dashboard treats
# GB10 the same way in SystemCollector (MemTotal as pool size).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ -n "${SPARKDASH_GPU_MEMORY_JSON:-}" ]; then
  OUTPUT="$SPARKDASH_GPU_MEMORY_JSON"
elif [ -n "${SPARKDASH_CONFIG:-}" ]; then
  OUTPUT="${SPARKDASH_CONFIG%/}/gpu-memory.json"
else
  OUTPUT="${SCRIPT_DIR}/gpu-memory.json"
fi

mkdir -p "$(dirname "$OUTPUT")"

# Prefer Python for safe JSON (process names may contain quotes/spaces).
if command -v python3 >/dev/null 2>&1; then
  python3 - "$OUTPUT" <<'PY'
import json, os, re, subprocess, sys, time

out_path = sys.argv[1]
processes = []
used = 0

try:
    raw = subprocess.check_output(
        [
            "nvidia-smi",
            "--query-compute-apps=pid,process_name,used_gpu_memory",
            "--format=csv,noheader,nounits",
        ],
        stderr=subprocess.DEVNULL,
        text=True,
    )
except (subprocess.CalledProcessError, FileNotFoundError):
    raw = ""

for line in raw.splitlines():
    line = line.strip()
    if not line:
        continue
    # CSV: pid, process_name (may contain commas rarely), used_gpu_memory
    parts = [p.strip() for p in line.split(",")]
    if len(parts) < 3:
        continue
    try:
        pid = int(parts[0])
    except ValueError:
        continue
    try:
        vram = float(parts[-1])
    except ValueError:
        continue
    if not (pid > 0 and vram == vram):  # vram == vram rejects NaN
        continue
    name = ",".join(parts[1:-1]).strip() or "unknown"
    vram_i = int(round(vram))
    used += vram_i
    processes.append({"pid": pid, "name": name, "vramMB": vram_i})

total = 0
try:
    with open("/proc/meminfo", "r", encoding="utf-8") as f:
        for line in f:
            if line.startswith("MemTotal:"):
                kb = int(line.split()[1])
                total = int(round(kb / 1024.0))
                break
except OSError:
    pass

payload = {
    "used": int(used),
    "total": int(total),
    "processes": processes,
    "timestamp": int(time.time()),
}

tmp = out_path + f".{os.getpid()}.tmp"
with open(tmp, "w", encoding="utf-8") as f:
    json.dump(payload, f, separators=(",", ":"))
    f.write("\n")
os.replace(tmp, out_path)
PY
  exit 0
fi

# Fallback without Python: aggregate used only (no process names — safer than broken JSON).
USED=$(
  nvidia-smi --query-compute-apps=used_gpu_memory --format=csv,noheader,nounits 2>/dev/null \
    | awk '{s+=$1} END {printf "%.0f", s+0}'
)
TOTAL=$(awk '/^MemTotal:/ {printf "%.0f", $2/1024}' /proc/meminfo 2>/dev/null || echo 0)
TS=$(date +%s)
TMP="${OUTPUT}.$$.tmp"
printf '{"used":%s,"total":%s,"processes":[],"timestamp":%s}\n' "${USED:-0}" "${TOTAL:-0}" "$TS" >"$TMP"
mv -f "$TMP" "$OUTPUT"
