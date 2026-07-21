#!/bin/bash
OUTPUT="/opt/sparkDash/config/gpu-memory.json"

COMPUTE_RAW=$(nvidia-smi --query-compute-apps=pid,process_name,used_gpu_memory --format=csv,noheader,nounits 2>/dev/null)

USED=0
PROCESSES=""
while IFS=", " read -r pid pname vram; do
    [ -z "$pid" ] && continue
    USED=$((USED + vram))
    if [ -n "$PROCESSES" ]; then PROCESSES="$PROCESSES,"; fi
    PROCESSES="${PROCESSES}{\"pid\":$pid,\"name\":\"$pname\",\"vramMB\":$vram}"
done <<< "$COMPUTE_RAW"

TOTAL=$(awk "/^MemTotal:/ {printf \"%.0f\", \$2/1024}" /proc/meminfo)
echo "{\"used\": $USED, \"total\": $TOTAL, \"processes\": [$PROCESSES], \"timestamp\": $(date +%s)}" > "$OUTPUT"
