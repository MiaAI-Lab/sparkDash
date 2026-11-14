# Clear Docker's build cache that nothing uses and that Docker last used more than $1 days ago (1 to 365), on the
# builder built into the Docker daemon this account talks to: the daemon whose "Build Cache" figure `docker system df`
# reports. Docker itself decides what is unused (cache a running build holds is never removed) and says how much it
# reclaimed. Anything that cannot be established fails closed: nothing is cleared.
export LC_ALL=C
command -v docker >/dev/null 2>&1 || fail no-docker "Docker is not installed on this Spark"
DAYS=${1-}
# Plain digits without a leading zero (the shell would read 010 as octal), then the range.
case "$DAYS" in
  [1-9] | [1-9][0-9] | [1-9][0-9][0-9]) ;;
  *) fail bad-args "The age must be a whole number of days from 1 to 365" ;;
esac
[ "$DAYS" -le 365 ] || fail bad-args "The age must be a whole number of days from 1 to 365"
if ! INFO=$(timeout 20 docker info --format '{{.DockerRootDir}}' 2>&1); then
  case "$INFO" in
    *"permission denied"*) fail docker-denied "Docker needs administrator rights for this account" ;;
    *) fail docker-down "Docker is not running on this Spark" ;;
  esac
fi
UNKNOWN="Could not tell which Docker builder holds this build cache, so nothing was cleared"
# Which builder `docker builder` reaches. With the buildx plugin it is whichever builder was selected, which may be a
# container or another machine, so it is pinned to the one built into this daemon: the builder named after the current
# Docker context, with the "docker" driver. Without buildx, `docker builder` is the daemon's own builder.
HELP=$(timeout 20 docker builder prune --help 2>&1) || fail builder-unknown "$UNKNOWN"
case "$HELP" in
  *--builder*)
    CTX=$(timeout 20 docker context show 2>/dev/null) || fail builder-unknown "$UNKNOWN"
    case "$CTX" in '' | *[!A-Za-z0-9._-]*) fail builder-unknown "$UNKNOWN" ;; esac
    DESC=$(timeout 30 docker buildx inspect "$CTX" 2>/dev/null) || fail builder-unknown "$UNKNOWN"
    DRIVER=$(printf '%s\n' "$DESC" | sed -n 's/^Driver:[[:space:]]*//p' | head -n 1)
    [ "$DRIVER" = docker ] || fail builder-unknown "The Docker builder in use is not the one built into Docker, so its cache is not cleared from here"
    ADAPTER=buildx
    set -- --builder "$CTX"
    ;;
  *)
    ADAPTER=daemon
    set --
    ;;
esac
# --all: every kind of unused cache, which is what Docker's "reclaimable" figure counts. until: last used before then.
if OUT=$(timeout 900 docker builder prune "$@" --force --all --filter "until=$((DAYS * 24))h" 2>&1); then
  # buildx prints "Total: 1.2GB", the daemon's own builder "Total reclaimed space: 1.2GB".
  TOTAL=$(printf '%s\n' "$OUT" | sed -n 's/^Total[^:]*:[[:space:]]*//p' | tail -n 1)
  printf 'RESULT=ok\nADAPTER=%s\nDAYS=%s\nRECLAIMED=%s\n' "$ADAPTER" "$DAYS" "$(clean "$TOTAL")"
else
  fail prune-failed "Docker could not clear the build cache: $(clean "$(printf '%s\n' "$OUT" | grep . | tail -n 1)")"
fi
