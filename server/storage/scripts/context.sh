# Read-only: where and as whom Storage Manager programs run on this Spark, and which tools are there.
# Never elevated. Every check is cheap (no daemon is asked for anything but a version), so it can run
# once per Spark and be cached. Each value is reduced to plain characters before it is printed.
export LC_ALL=C
digits() { tr -cd '0-9'; }
one_line() { tr -d '\r\n'; }
yn() { if "$@" >/dev/null 2>&1; then echo yes; else echo no; fi; }
has() { command -v "$1" >/dev/null 2>&1; }

printf 'RESULT=ok\n'
U=$(id -u 2>/dev/null | digits)
NAME=$(id -un 2>/dev/null | tr -cd 'A-Za-z0-9._-')
printf 'UID=%s\n' "$U"
printf 'ACCOUNT=%s\n' "$NAME"
# $HOME as these programs see it, and the account's home from the user database: they differ when the
# environment is not the account's own (a container entering the host's mount namespace, for example).
printf 'HOME=%s\n' "$(printf '%s' "${HOME-}" | one_line)"
PWHOME=''
if [ -n "$U" ]; then
  if has getent; then PWHOME=$(getent passwd "$U" 2>/dev/null | head -n 1 | cut -d: -f6); fi
  [ -n "$PWHOME" ] || PWHOME=$(awk -F: -v u="$U" '$3 == u { print $6; exit }' /etc/passwd 2>/dev/null)
fi
printf 'ACCOUNT_HOME=%s\n' "$(printf '%s' "$PWHOME" | one_line)"
H=$(hostname 2>/dev/null || cat /proc/sys/kernel/hostname 2>/dev/null)
printf 'HOSTNAME=%s\n' "$(printf '%s' "$H" | head -n 1 | tr -cd 'A-Za-z0-9.-')"
printf 'BOOT_ID=%s\n' "$(head -c 64 /proc/sys/kernel/random/boot_id 2>/dev/null | tr -cd '0-9a-f-')"
# Namespace identities (the inode numbers in /proc/<pid>/ns/*). PID 1's are only readable as root.
for ns in mnt pid user net cgroup uts; do
  KEY=$(printf '%s' "$ns" | tr 'a-z' 'A-Z')
  printf 'NS_%s=%s\n' "$KEY" "$(readlink "/proc/self/ns/$ns" 2>/dev/null | digits)"
done
printf 'INIT_NS_MNT=%s\n' "$(readlink /proc/1/ns/mnt 2>/dev/null | digits)"
printf 'INIT_NS_PID=%s\n' "$(readlink /proc/1/ns/pid 2>/dev/null | digits)"
if [ -f /.dockerenv ] || [ -f /run/.containerenv ]; then printf 'IN_CONTAINER=1\n'; else printf 'IN_CONTAINER=0\n'; fi

# Tools. systemd-run is only checked for presence and --user support (its version answer); whether a
# transient user unit really starts is a separate, heavier probe that this program does not make.
if has systemd-run; then printf 'SYSTEMD_RUN=%s\n' "$(yn timeout 5 systemd-run --user --version)"; else printf 'SYSTEMD_RUN=no\n'; fi
L=unknown
if [ -n "$NAME" ] && [ -d /var/lib/systemd/linger ]; then
  if [ -e "/var/lib/systemd/linger/$NAME" ]; then L=yes; else L=no; fi
elif [ -n "$NAME" ] && has loginctl; then
  case "$(timeout 5 loginctl show-user "$NAME" --property=Linger --value 2>/dev/null)" in
    yes) L=yes ;;
    no) L=no ;;
  esac
fi
printf 'LINGER=%s\n' "$L"
for t in perl findmnt docker setsid flock; do
  KEY=$(printf '%s' "$t" | tr 'a-z' 'A-Z')
  if has "$t"; then printf '%s=yes\n' "$KEY"; else printf '%s=no\n' "$KEY"; fi
done
# buildx is a Docker CLI plugin: asking its version does not need the daemon.
if has docker; then printf 'BUILDX=%s\n' "$(yn timeout 5 docker buildx version)"; else printf 'BUILDX=no\n'; fi
if [ "$U" = 0 ]; then
  S=root
elif has sudo && timeout 5 sudo -n true >/dev/null 2>&1; then
  S=yes
else
  S=no
fi
printf 'SUDO=%s\n' "$S"
exit 0
