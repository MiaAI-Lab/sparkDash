# Read-only: who we are, whether sudo works without a password, the disks, and whether Docker answers.
export LC_ALL=C
printf 'RESULT=ok\n'
printf 'USER=%s\n' "$(id -un 2>/dev/null | tr -cd 'A-Za-z0-9._-')"
# The account's own home, and every ordinary person's home under /home (never /root): the folder to look at by default.
H=$(getent passwd "$(id -u)" 2>/dev/null | cut -d: -f6)
[ -n "$H" ] || H=${HOME:-}
printf 'HOME_DIR=%s\n' "$(clean "$H")"
getent passwd 2>/dev/null | while IFS=: read -r _n _p uid _g _c dir _s; do
  case "$uid" in ''|*[!0-9]*) continue ;; esac
  [ "$uid" -ge 1000 ] && [ "$uid" -lt 60000 ] || continue
  case "$dir" in /home/*) [ -d "$dir" ] && printf 'PEOPLE_HOME=%s\n' "$(clean "$dir")" ;; esac
done
printf 'BOOT_ID=%s\n' "$(head -c 64 /proc/sys/kernel/random/boot_id 2>/dev/null | tr -cd '0-9a-f-')"
if [ "$(id -u)" = 0 ]; then
  S=root
elif command -v sudo >/dev/null 2>&1 && timeout 5 sudo -n true >/dev/null 2>&1; then
  S=yes
else
  S=no
fi
printf 'SUDO=%s\n' "$S"
df -P -B1 -T 2>/dev/null | tail -n +2 | while IFS= read -r line; do printf 'FS=%s\n' "$line"; done
if ! command -v docker >/dev/null 2>&1; then
  D=missing
  ROOT=''
elif ROOT=$(timeout 10 docker info --format '{{.DockerRootDir}}' 2>&1); then
  D=ok
else
  case "$ROOT" in
    *"permission denied"*) D=denied ;;
    *) D=down ;;
  esac
  ROOT=''
fi
printf 'DOCKER=%s\n' "$D"
printf 'DOCKER_ROOT=%s\n' "$(clean "$ROOT")"
