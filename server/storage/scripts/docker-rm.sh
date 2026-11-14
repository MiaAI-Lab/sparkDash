# Remove containers by ID. A container that is running, restarting or paused is never touched (it is
# checked again here, right before): only containers that are already stopped go. Volumes are kept.
export LC_ALL=C
command -v docker >/dev/null 2>&1 || fail no-docker "Docker is not installed on this Spark"
for ID in "$@"; do
  case "$ID" in
    [0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]*) ;;
    *) printf 'SKIPPED=%s|invalid\n' "$(clean "$ID")"; continue ;;
  esac
  # Only an answer that says "stopped" lets a container go: a failed or unexpected answer leaves it alone.
  if ! STATE=$(timeout 60 docker container inspect --format '{{.State.Status}}' "$ID" 2>&1); then
    case "$STATE" in
      *"No such container"* | *"No such object"*) printf 'SKIPPED=%s|gone\n' "$ID" ;;
      *) printf 'SKIPPED=%s|check-failed\n' "$ID" ;;
    esac
    continue
  fi
  case "$STATE" in
    exited | created | dead) ;;
    running | restarting | paused | removing) printf 'SKIPPED=%s|running\n' "$ID"; continue ;;
    *) printf 'SKIPPED=%s|check-failed\n' "$ID"; continue ;;
  esac
  if OUT=$(timeout 120 docker container rm "$ID" 2>&1); then
    printf 'REMOVED=%s\n' "$ID"
  else
    printf 'FAILED=%s|%s\n' "$ID" "$(clean "$OUT")"
  fi
done
printf 'RESULT=ok\n'
