# Status of, or stop, one scan this dashboard started. Run with bash, as the account that started the scan.
# $1 status|cancel  $2 job id  $3 grace in ms between TERM and KILL (cancel)  $4 ms to wait after KILL (cancel)
#
# status: STATE=running (some process of the job is alive) | gone (none is) | unknown (could not tell).
# cancel: OUTCOME=terminated (stopped, and nothing of it is left) | already-gone (nothing was running) |
#         not-terminated (still running after KILL) | unknown (could not prove what to signal: nothing was).
# Both add REASON and LOCK (the unit lock: free | held | unknown).
#
# Nothing is signalled that is not proven to be the job: the process group is signalled only while its
# leader matches the record (same boot, start time, owner and group, and /proc numbering processes as kill
# does); single processes only when they belong to this account and carry the job's tag.
export LC_ALL=C
ACT=${1-}
ID=${2-}
GRACE_MS=${3:-5000}
KILL_WAIT_MS=${4:-3000}
case "$ID" in
  [0-9a-f]*-*) ;;
  *) fail bad-job "Not a job id" ;;
esac
case "$ID" in *[!0-9a-f-]*) fail bad-job "Not a job id" ;; esac
[ "${#ID}" -eq 36 ] || fail bad-job "Not a job id"
case "$GRACE_MS" in '' | *[!0-9]*) GRACE_MS=5000 ;; esac
case "$KILL_WAIT_MS" in '' | *[!0-9]*) KILL_WAIT_MS=3000 ;; esac
sd_state_init || fail no-state "The dashboard's state folder on this Spark (~/.local/state/sparkdash) is missing or not private"
DIR=$SD_STATE/jobs/$ID

finish() {
  printf 'RESULT=ok\n%s=%s\nREASON=%s\nLOCK=%s\n' "$1" "$2" "$3" "$(sd_lock_probe)"
  exit 0
}

if [ "$ACT" = status ]; then
  sd_tagged "$ID" || finish STATE unknown no-process-check
  [ -n "$SD_TAGGED" ] && finish STATE running alive
  finish STATE gone finished
fi
[ "$ACT" = cancel ] || fail bad-job "Unknown action"

sd_tagged "$ID" || finish OUTCOME unknown no-process-check
[ -n "$SD_TAGGED" ] || finish OUTCOME already-gone finished

# Something of the job runs: prove who it is before signalling anything.
sd_job_load "$DIR" || finish OUTCOME unknown no-record
[ "$SDJ_JOB" = "$ID" ] || finish OUTCOME unknown identity
[ "$SDJ_OWNER" = "$(id -u)" ] || finish OUTCOME unknown owner
sd_boot && [ "$SDJ_BOOT" = "$SD_BOOT" ] || finish OUTCOME unknown boot
{ [ "$SDJ_NS" = same ] && sd_ns_same; } || finish OUTCOME unknown pid-namespace

# The group leader: ours only if it started when the record says (a different start time means the pid was
# reused, so the recorded group is gone and only tagged processes are left to stop).
leader_ok() {
  sd_stat "$SDJ_PID" || return 1
  [ "$SD_START" = "$SDJ_START" ] || return 1
  [ "$SD_PGRP" = "$SDJ_PGID" ] && [ "$SD_SID" = "$SDJ_PGID" ] && [ -O "/proc/$SDJ_PID" ] || return 2
  return 0
}
leader_ok
case $? in
  2) finish OUTCOME unknown identity ;;
esac

# $1 signal: the verified group, then every tagged process (some move to their own group, like timeout).
signal_job() {
  leader_ok && kill -s "$1" -- "-$SDJ_PGID" 2>/dev/null
  sd_tagged "$ID" || return 1
  for p in $SD_TAGGED; do kill -s "$1" "$p" 2>/dev/null; done
  return 0
}

# $1 ms to wait for the job to be gone, sending signal $2 again now and then. 0 gone, 1 still there, 2 cannot tell.
wait_gone() {
  n=$(($1 / 100))
  i=0
  while :; do
    sd_tagged "$ID" || return 2
    [ -z "$SD_TAGGED" ] && return 0
    [ "$i" -ge "$n" ] && return 1
    i=$((i + 1))
    sleep 0.1
    # New processes may have started since the last signal (a worker that was being started).
    [ $((i % 10)) -eq 0 ] && signal_job "$2"
  done
}

signal_job TERM || finish OUTCOME unknown no-process-check
wait_gone "$GRACE_MS" TERM
case $? in
  0) finish OUTCOME terminated term ;;
  2) finish OUTCOME unknown no-process-check ;;
esac
signal_job KILL || finish OUTCOME unknown no-process-check
wait_gone "$KILL_WAIT_MS" KILL
case $? in
  0) finish OUTCOME terminated kill ;;
  1) finish OUTCOME not-terminated still-running ;;
esac
finish OUTCOME unknown no-process-check
