# Remove images by ID, tag by tag and never with --force. Each one is checked again for containers right
# before it goes, so an image that started being used after the list was drawn is left alone. Docker itself
# refuses to remove an image a container (even one created a moment ago) still uses, and that is reported.
export LC_ALL=C
command -v docker >/dev/null 2>&1 || fail no-docker "Docker is not installed on this Spark"
for ID in "$@"; do
  case "$ID" in
    sha256:*) ;;
    *) printf 'SKIPPED=%s|invalid\n' "$(clean "$ID")"; continue ;;
  esac
  # Only a check that really ran and found nothing counts as "unused": if Docker cannot answer, leave the image alone.
  if ! USED=$(timeout 60 docker ps -aq --no-trunc --filter "ancestor=$ID" 2>/dev/null); then
    printf 'SKIPPED=%s|check-failed\n' "$ID"
    continue
  fi
  if [ -n "$USED" ]; then
    printf 'SKIPPED=%s|in-use\n' "$ID"
    continue
  fi
  # The tags the image carries now. "No such image" means it is already gone; any other failure is unknown.
  if ! TAGS=$(timeout 60 docker image inspect --format '{{range .RepoTags}}{{println .}}{{end}}' "$ID" 2>&1); then
    case "$TAGS" in
      *"No such image"*|*"no such image"*) printf 'SKIPPED=%s|gone\n' "$ID" ;;
      *) printf 'SKIPPED=%s|check-failed\n' "$ID" ;;
    esac
    continue
  fi
  BAD=''
  # Untag one tag at a time: an image with several tags cannot be removed by ID without force.
  while IFS= read -r TAG; do
    [ -n "$TAG" ] || continue
    case "$TAG" in '<none>'*) continue ;; esac
    if ! OUT=$(timeout 300 docker image rm "$TAG" 2>&1); then
      BAD=$(clean "$OUT")
      break
    fi
  done <<EOF
$TAGS
EOF
  if [ -n "$BAD" ]; then
    printf 'FAILED=%s|%s\n' "$ID" "$BAD"
    continue
  fi
  # Removing the last tag usually deletes the image. If it is still there (untagged, or it had no tags), remove it by ID.
  if timeout 60 docker image inspect --format '{{.Id}}' "$ID" >/dev/null 2>&1; then
    if OUT=$(timeout 300 docker image rm "$ID" 2>&1); then
      printf 'REMOVED=%s\n' "$ID"
    else
      printf 'FAILED=%s|%s\n' "$ID" "$(clean "$OUT")"
    fi
  else
    printf 'REMOVED=%s\n' "$ID"
  fi
done
printf 'RESULT=ok\n'
