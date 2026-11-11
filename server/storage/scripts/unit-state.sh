# Unit-side state of the Storage Manager (POSIX sh; also used from bash). Defines functions only.
#
# ~/.local/state/sparkdash/            private folder of this account (0700, never a symbolic link)
#   storage.lock                       the unit lock: one scan or change at a time per account, even across
#                                      dashboards. Held with flock on fd 9 by the program and by every process
#                                      it starts, so it is released only when the last of them is gone.
#   jobs/<id>/state                    who a running scan is: process group, start time, boot, owner
#   jobs/<id>/end                      written when the scan's session leader has exited
#
# Every process of a scan also carries SPARKDASH_JOB=<id> in its environment. The id is random, so "a process
# of this account whose environment holds that tag" identifies the scan's processes and nothing else, even
# those that moved to another process group (GNU timeout does) or outlived the leader.

SD_FLOCK=flock
SD_LOCK_MODE=""

# $1 folder: create it (0700) when missing. Refuses a symbolic link and a folder another account owns.
sd_private_dir() {
  [ -L "$1" ] && return 1
  [ -d "$1" ] || (umask 077 && mkdir -- "$1") 2>/dev/null || [ -d "$1" ] || return 1
  [ ! -L "$1" ] && [ -d "$1" ] && [ -O "$1" ] || return 1
  chmod 700 -- "$1" 2>/dev/null
}

# Sets SD_STATE and makes sure it and its jobs folder are private.
sd_state_init() {
  [ -n "${HOME-}" ] && [ -d "$HOME" ] || return 1
  # ~/.local/state is shared with other programs: only created when missing, never changed.
  [ -d "$HOME/.local/state" ] || mkdir -p -- "$HOME/.local/state" 2>/dev/null
  [ -d "$HOME/.local/state" ] || return 1
  SD_STATE=$HOME/.local/state/sparkdash
  sd_private_dir "$SD_STATE" && sd_private_dir "$SD_STATE/jobs"
}

# $1 file, $2 content: written under a temporary name in the same folder, then renamed over the file.
sd_write() {
  sd_tmp="$1.tmp.$$"
  rm -f -- "$sd_tmp" 2>/dev/null
  (umask 077 && set -C && printf '%s' "$2" > "$sd_tmp") 2>/dev/null || return 1
  mv -f -- "$sd_tmp" "$1"
}

sd_boot() {
  SD_BOOT=""
  { read -r SD_BOOT < /proc/sys/kernel/random/boot_id; } 2>/dev/null
  case "$SD_BOOT" in '' | *[!0-9a-f-]*) return 1 ;; esac
}

# $1 pid, or "self" for the calling shell. Sets SD_SEEN (the pid as /proc numbers it), SD_PSTATE, SD_PGRP, SD_SID
# and SD_START (start time in clock ticks after boot, field 22). Fails for a missing process.
sd_stat() {
  sd_line=""
  { read -r sd_line < "/proc/$1/stat"; } 2>/dev/null || return 1
  SD_SEEN=${sd_line%% *}
  # The command name (field 2) may hold spaces and brackets: everything up to its last ") " goes.
  # shellcheck disable=SC2086
  set -- ${sd_line##*) }
  [ "$#" -ge 20 ] || return 1
  SD_PSTATE=$1
  SD_PGRP=$3
  SD_SID=$4
  shift 19
  SD_START=$1
}

# True when /proc numbers processes the way this shell's kill does. Not the case in a container that sees the
# host's /proc but has its own PID namespace: there, nothing found in /proc may be signalled.
sd_ns_same() {
  sd_self=""
  { read -r sd_self < /proc/self/stat; } 2>/dev/null || return 1
  [ "${sd_self%% *}" = "$$" ]
}

# $1 job id. Sets SD_TAGGED to the pids of this account's processes that carry the job's tag (zombies carry
# nothing). Fails when the check itself cannot run, so "none found" is never a guess.
sd_tagged() {
  SD_TAGGED=""
  printf 'SPARKDASH_JOB=x\0' | grep -qzxF 'SPARKDASH_JOB=x' 2>/dev/null || return 1
  [ -r /proc/self/environ ] || return 1
  # Other accounts' environments cannot be read: grep's complaints about them are expected.
  for sd_f in $(grep -lzxF "SPARKDASH_JOB=$1" /proc/[0-9]*/environ 2>/dev/null); do
    sd_p=${sd_f#/proc/}
    sd_p=${sd_p%/environ}
    case "$sd_p" in '' | *[!0-9]*) continue ;; esac
    [ -O "/proc/$sd_p" ] && SD_TAGGED="$SD_TAGGED $sd_p"
  done
  return 0
}

# ─── The unit lock ─────────────────────────────────────────────

# $1 seconds to wait. Takes the unit lock on fd 9 (kept by every process started from here on).
# 1 = someone else holds it, 2 = it could not be used at all.
sd_lock() {
  SD_LOCKF=$SD_STATE/storage.lock
  [ -L "$SD_LOCKF" ] && return 2
  if [ -n "$SD_FLOCK" ] && command -v "$SD_FLOCK" >/dev/null 2>&1; then
    exec 9>>"$SD_LOCKF" || return 2
    if "$SD_FLOCK" -w "$1" 9; then
      SD_LOCK_MODE=flock
      return 0
    fi
    exec 9>&-
    return 1
  fi
  sd_pidlock "$1"
}

# Without flock: a lock file created exclusively, holding this shell's pid, start time and boot. A holder that
# is gone (another boot, no such process, or a new process that reuses the pid) leaves a stale file, which is
# taken over. Weaker than flock: it covers this shell only, not processes that outlive it.
sd_pidlock() {
  SD_PIDF=$SD_STATE/storage.lock.pid
  sd_boot || return 2
  { read -r sd_me < /proc/self/stat; } 2>/dev/null || return 2
  sd_stat "${sd_me%% *}" || return 2
  sd_rec="PID=$SD_SEEN
START=$SD_START
BOOT=$SD_BOOT
"
  sd_n=$(($1 * 5))
  while :; do
    if (umask 077 && set -C && printf '%s' "$sd_rec" > "$SD_PIDF") 2>/dev/null; then
      SD_LOCK_MODE=pidfile
      return 0
    fi
    [ -L "$SD_PIDF" ] && return 2
    if sd_pidlock_stale; then
      # Move the stale file aside, then make sure it is the one that was judged stale: another dashboard may
      # have replaced it in between, and that one is put back.
      if mv -f -- "$SD_PIDF" "$SD_PIDF.stale.$$" 2>/dev/null; then
        if [ "$(cat -- "$SD_PIDF.stale.$$" 2>/dev/null)" = "$sd_old" ]; then
          rm -f -- "$SD_PIDF.stale.$$"
        else
          mv -n -- "$SD_PIDF.stale.$$" "$SD_PIDF" 2>/dev/null || rm -f -- "$SD_PIDF.stale.$$"
        fi
      fi
      continue
    fi
    [ "$sd_n" -gt 0 ] || return 1
    sd_n=$((sd_n - 1))
    sleep 0.2
  done
}

# 0 when the pid lock file's holder is certainly gone. Sets sd_old to the file's content.
sd_pidlock_stale() {
  sd_old=$(cat -- "$SD_PIDF" 2>/dev/null) || return 1
  sd_lp="" sd_ls="" sd_lb=""
  for sd_kv in $sd_old; do
    case "$sd_kv" in
      PID=*) sd_lp=${sd_kv#PID=} ;;
      START=*) sd_ls=${sd_kv#START=} ;;
      BOOT=*) sd_lb=${sd_kv#BOOT=} ;;
    esac
  done
  case "$sd_lp$sd_ls" in '' | *[!0-9]*) return 1 ;; esac
  sd_boot || return 1
  [ "$sd_lb" != "$SD_BOOT" ] && return 0
  sd_stat "$sd_lp" || return 0
  [ "$SD_START" != "$sd_ls" ]
}

sd_unlock() {
  [ "$SD_LOCK_MODE" = pidfile ] || return 0
  [ "$(cat -- "$SD_PIDF" 2>/dev/null)" = "$(printf '%s' "$sd_rec")" ] && rm -f -- "$SD_PIDF"
  SD_LOCK_MODE=""
}

# Prints free, held or unknown, without keeping the lock.
sd_lock_probe() {
  SD_LOCKF=$SD_STATE/storage.lock
  SD_PIDF=$SD_STATE/storage.lock.pid
  if [ -n "$SD_FLOCK" ] && command -v "$SD_FLOCK" >/dev/null 2>&1; then
    [ -e "$SD_LOCKF" ] || { echo free; return 0; }
    [ -L "$SD_LOCKF" ] && { echo unknown; return 0; }
    # A lock taken here is let go when this subshell ends.
    (exec 8>>"$SD_LOCKF") 2>/dev/null || { echo unknown; return 0; }
    if (exec 8>>"$SD_LOCKF" && "$SD_FLOCK" -n 8) 2>/dev/null; then echo free; else echo held; fi
    return 0
  fi
  [ -e "$SD_PIDF" ] || { echo free; return 0; }
  if sd_pidlock_stale; then echo free; else echo held; fi
}

# ─── Scan jobs ─────────────────────────────────────────────────

# $1 job id. Clears away jobs that are certainly over, then makes the job's private folder.
# Sets SD_JOB_DIR. Called with the unit lock held, so no other job is starting meanwhile.
sd_job_prepare() {
  for sd_d in "$SD_STATE"/jobs/*; do
    [ -d "$sd_d" ] && [ ! -L "$sd_d" ] || continue
    sd_j=${sd_d##*/}
    case "$sd_j" in '' | *[!0-9a-f-]*) continue ;; esac
    sd_tagged "$sd_j" && [ -z "$SD_TAGGED" ] && rm -rf -- "$sd_d"
  done
  SD_JOB_DIR=$SD_STATE/jobs/$1
  sd_private_dir "$SD_JOB_DIR"
}

# First thing a job does, in its own session: record the group, the leader's start time, the boot and owner.
# Only the leader of its own session and group is recorded: signalling any other group could hit the shell
# that started it.
sd_job_record() {
  [ -n "${SPARKDASH_JOB_DIR-}" ] && [ -d "$SPARKDASH_JOB_DIR" ] && [ ! -L "$SPARKDASH_JOB_DIR" ] || return 0
  if sd_ns_same; then sd_ns=same; else sd_ns=foreign; fi
  sd_stat self || return 0
  [ "$SD_PGRP" = "$SD_SEEN" ] && [ "$SD_SID" = "$SD_SEEN" ] || return 0
  sd_boot || return 0
  sd_write "$SPARKDASH_JOB_DIR/state" "V=1
JOB=${SPARKDASH_JOB-}
PID=$SD_SEEN
PGID=$SD_PGRP
START=$SD_START
BOOT=$SD_BOOT
OWNER=$(id -u)
NS=$sd_ns
"
}

# $1 exit status of the session leader.
sd_job_end() {
  [ -n "${SD_JOB_DIR-}" ] && [ -d "$SD_JOB_DIR" ] || return 0
  sd_write "$SD_JOB_DIR/end" "RC=$1
"
}

# $1 job folder. Reads its state record into SDJ_*; fails for a missing, foreign or malformed record.
sd_job_load() {
  SDJ_JOB="" SDJ_PID="" SDJ_PGID="" SDJ_START="" SDJ_BOOT="" SDJ_OWNER="" SDJ_NS=""
  [ -d "$1" ] && [ ! -L "$1" ] && [ -O "$1" ] || return 1
  [ -f "$1/state" ] && [ ! -L "$1/state" ] && [ -O "$1/state" ] || return 1
  while IFS= read -r sd_kv; do
    case "$sd_kv" in
      JOB=*) SDJ_JOB=${sd_kv#JOB=} ;;
      PID=*) SDJ_PID=${sd_kv#PID=} ;;
      PGID=*) SDJ_PGID=${sd_kv#PGID=} ;;
      START=*) SDJ_START=${sd_kv#START=} ;;
      BOOT=*) SDJ_BOOT=${sd_kv#BOOT=} ;;
      OWNER=*) SDJ_OWNER=${sd_kv#OWNER=} ;;
      NS=*) SDJ_NS=${sd_kv#NS=} ;;
    esac
  done < "$1/state"
  case "$SDJ_PID$SDJ_PGID$SDJ_START$SDJ_OWNER" in '' | *[!0-9]*) return 1 ;; esac
  [ -n "$SDJ_PID" ] && [ -n "$SDJ_PGID" ] && [ -n "$SDJ_START" ] && [ -n "$SDJ_OWNER" ] || return 1
  case "$SDJ_BOOT" in '' | *[!0-9a-f-]*) return 1 ;; esac
  case "$SDJ_NS" in same | foreign) ;; *) return 1 ;; esac
}
