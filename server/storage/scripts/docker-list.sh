# Read-only: Docker disk use, every image with its size, and every container with the image it uses.
export LC_ALL=C
command -v docker >/dev/null 2>&1 || fail no-docker "Docker is not installed on this Spark"
if ! INFO=$(timeout 20 docker info --format '{{.DockerRootDir}}' 2>&1); then
  case "$INFO" in
    *"permission denied"*) fail docker-denied "Docker needs administrator rights for this account" ;;
    *) fail docker-down "Docker is not running on this Spark" ;;
  esac
fi
printf 'RESULT=ok\nROOT=%s\n' "$(clean "$INFO")"
# "light" skips the disk-use totals (the slow part): enough to see which images and containers exist.
[ "${1-}" = light ] || timeout 90 docker system df --format 'DF={{.Type}}|{{.TotalCount}}|{{.Active}}|{{.Size}}|{{.Reclaimable}}' 2>/dev/null
# Every query that fails is reported (IMAGES, CONTAINERS): the dashboard then treats what it could not see as
# unknown, never as "unused". An image only counts as unused when the container listing really ran in full.
if IDS=$(timeout 60 docker image ls -aq --no-trunc 2>/dev/null); then IMAGES=ok; else IMAGES=failed; IDS=""; fi
IDS=$(printf '%s\n' "$IDS" | sort -u)
# shellcheck disable=SC2086
# The last field counts registry digests: 0 means the image was never pulled from (or pushed to) a registry.
[ -z "$IDS" ] || timeout 60 docker image inspect --format 'IMG={{.Id}}|{{.Size}}|{{.Created}}|{{range $i, $t := .RepoTags}}{{if $i}},{{end}}{{$t}}{{end}}|{{len .RepoDigests}}' $IDS 2>/dev/null || IMAGES=partial
if CIDS=$(timeout 60 docker ps -aq --no-trunc 2>/dev/null); then CONTAINERS=ok; else CONTAINERS=failed; CIDS=""; fi
# shellcheck disable=SC2086
if [ -n "$CIDS" ]; then
  # The last field is when the container last stopped (Docker's zero time, year 1, when it never ran).
  timeout 60 docker container inspect --format 'CTR={{.Image}}|{{.Name}}|{{.State.Status}}|{{.Id}}|{{.Created}}|{{.State.FinishedAt}}' $CIDS 2>/dev/null || CONTAINERS=failed
fi
printf 'IMAGES=%s\nCONTAINERS=%s\n' "$IMAGES" "$CONTAINERS"
exit 0
