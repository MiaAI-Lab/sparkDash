#!/bin/bash
# Measure how often nvidia-smi is started and what the dashboard's GPU
# collection costs in CPU, on the host running sparkDash locally.
#
#   scripts/nvidia-smi-load.sh [-d SECONDS] [-p NODE_PID] [-i SAMPLE_SECONDS]
#
# Run it once on the current build and once on the build under test, with the
# same Settings -> Poll interval and the same GPU load, and compare the lines
# it prints. Run as root (or with sudo) when sparkDash runs in Docker: the
# container's processes then belong to root. The compose files use
# `pid: host`, so the server and its nvidia-smi children are visible here.
#
# Spawn count:
#   - exact, when the script runs as root and bpftrace (preferred) or perf is
#     installed: every exec of nvidia-smi (and of nsenter, which wraps it in
#     Docker), system-wide;
#   - always also a lower bound: distinct nvidia-smi PIDs seen by sampling
#     every SAMPLE_SECONDS (default 0.1). A run shorter than the sample
#     period can be missed.
#
# CPU (percent of one core, averaged over the window, from /proc/<pid>/stat):
#   - node self:       the sparkDash server process itself;
#   - node children:   children it started and reaped during the window
#                      (per-poll nvidia-smi runs, nsenter, sh, other tools);
#   - live nvidia-smi: nvidia-smi processes still running at the end
#                      (long-lived readers), counted from their own counters.
#
# NOTE: keep this file ASCII-only.
set -uo pipefail
export LC_ALL=C

DURATION=300
NODE_PID=""
SAMPLE=0.1
while getopts "d:p:i:h" opt; do
  case "$opt" in
    d) DURATION="$OPTARG" ;;
    p) NODE_PID="$OPTARG" ;;
    i) SAMPLE="$OPTARG" ;;
    *) sed -n '2,30p' "$0"; exit 2 ;;
  esac
done

# The server process: `node server/index.js`, not the `node --watch` parent.
if [ -z "$NODE_PID" ]; then
  for pid in $(pgrep -f 'node .*server/index\.js' || true); do
    tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null | grep -q -- '--watch' && continue
    NODE_PID="$pid"
  done
fi
if [ -z "$NODE_PID" ] || [ ! -r "/proc/$NODE_PID/stat" ]; then
  echo "sparkDash server process not found; pass it with -p PID" >&2
  exit 1
fi
CLK_TCK=$(getconf CLK_TCK)

# Fields after the ")" of /proc/PID/stat: $12 utime $13 stime $14 cutime
# $15 cstime $20 starttime (proc(5) fields 14, 15, 16, 17, 22).
stat_fields() { sed 's/^.*) //' "/proc/$1/stat" 2>/dev/null; }
node_ticks() { stat_fields "$NODE_PID" | awk '{ print $12 + $13, $14 + $15 }'; }

declare -A first_ticks last_ticks
sample_smi() {
  local pid fields key ticks
  for pid in $(pgrep -x nvidia-smi || true); do
    fields=$(stat_fields "$pid") || continue
    [ -n "$fields" ] || continue
    key="$pid:$(awk '{ print $20 }' <<<"$fields")"
    ticks=$(awk '{ print $12 + $13 }' <<<"$fields")
    [ -n "${first_ticks[$key]+x}" ] || first_ticks[$key]=$ticks
    last_ticks[$key]=$ticks
  done
}

TRACER=""
TRACE_OUT=""
TRACE_PID=""
if [ "$(id -u)" -eq 0 ]; then
  if command -v bpftrace >/dev/null 2>&1; then
    TRACER=bpftrace
    TRACE_OUT=$(mktemp)
    bpftrace -q -e "tracepoint:sched:sched_process_exec /comm == \"nvidia-smi\" || comm == \"nsenter\"/ { @[comm] = count(); }
      interval:s:$DURATION { exit(); }" >"$TRACE_OUT" 2>&1 &
    TRACE_PID=$!
  elif command -v perf >/dev/null 2>&1; then
    TRACER=perf
    TRACE_OUT=$(mktemp)
    perf record -q -a -e sched:sched_process_exec -o "$TRACE_OUT" -- sleep "$DURATION" >/dev/null 2>&1 &
    TRACE_PID=$!
  fi
  [ -z "$TRACE_PID" ] || sleep 1 # let the probes attach before the window starts
fi

echo "node pid $NODE_PID: $(tr '\0' ' ' < "/proc/$NODE_PID/cmdline")"
echo "window ${DURATION}s, sampling every ${SAMPLE}s ..."
sample_smi
declare -A alive_at_start
for key in "${!first_ticks[@]}"; do alive_at_start[$key]=1; done
read -r self0 child0 < <(node_ticks)
now_us() { local t=$EPOCHREALTIME; echo "${t/./}"; }
start=$(now_us)
end=$((start + DURATION * 1000000))
while [ "$(now_us)" -lt "$end" ]; do
  sample_smi
  sleep "$SAMPLE"
done
read -r self1 child1 < <(node_ticks)
elapsed=$(awk -v us="$(($(now_us) - start))" 'BEGIN { printf "%.3f", us / 1e6 }')

seen=0
started=0
live_ticks=0
for key in "${!last_ticks[@]}"; do
  seen=$((seen + 1))
  [ -n "${alive_at_start[$key]+x}" ] || started=$((started + 1))
  if [ -d "/proc/${key%%:*}" ]; then
    live_ticks=$((live_ticks + last_ticks[$key] - first_ticks[$key]))
  fi
done

pct() { awk -v t="$1" -v hz="$CLK_TCK" -v s="$elapsed" 'BEGIN { printf "%.2f", t / hz / s * 100 }'; }
per_min() { awk -v n="$1" -v s="$elapsed" 'BEGIN { printf "%.1f", n / s * 60 }'; }

echo "elapsed:                     ${elapsed}s"
echo "nvidia-smi PIDs started:     $started ($(per_min "$started")/min, sampled lower bound)"
echo "nvidia-smi PIDs seen:        $seen (including ones already running)"
echo "CPU node self:               $(pct $((self1 - self0)))%"
echo "CPU node reaped children:    $(pct $((child1 - child0)))%"
echo "CPU live nvidia-smi:         $(pct "$live_ticks")%"
if [ -n "$TRACE_PID" ]; then
  wait "$TRACE_PID"
  echo "exec counts ($TRACER, ${DURATION}s window, exact):"
  if [ "$TRACER" = bpftrace ]; then
    sed -n 's/^@\[\(.*\)\]: \(.*\)$/  \1 \2/p' "$TRACE_OUT"
  else
    perf script -i "$TRACE_OUT" -F comm 2>/dev/null | awk '$1 == "nvidia-smi" || $1 == "nsenter"' | sort | uniq -c |
      awk '{ print "  " $2, $1 }'
  fi
  rm -f "$TRACE_OUT"
else
  echo "exec counts: no exact count (run as root with bpftrace or perf installed)"
fi
