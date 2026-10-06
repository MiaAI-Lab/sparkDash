#!/bin/sh
# install-clock-helper.sh — one-time provisioning for sparkDash clock control.
#
# Run ON the DGX Spark host (as a sudo-capable user):
#   bash install-clock-helper.sh
# or from the dashboard host over SSH:
#   ssh dgx@<host> 'sudo sh -s' < install-clock-helper.sh
#
# Installs:
#   1. /usr/local/bin/sparkdash-set-clock  (root-owned, 0755)
#   2. /etc/sudoers.d/sparkdash-clock      (scoped NOPASSWD, pinned argv)
#
# The sudoers drop-in is validated with visudo -c BEFORE installation.
# Review requirements (PR #98, second round):
#   1. ONE dedicated user — the grant names the dashboard's service account
#      (default `sparkdash-clock`, created here if missing), never `%sudo`
#      and never `ALL ALL`.
#   2. Exact argv, no trailing `*` — the alias enumerates the complete
#      flag sets the server sends (`--unlock` / `--max-mhz <N>` ×
#      `--persist` / `--no-persist` per domain) plus the bare binary for
#      the availability probe. The only wildcard is `[0-9]*` inside the
#      max-mhz VALUE position (digits-led numbers); it can never swallow
#      flags, so `--persist-path`-style extras and flag reordering can
#      never match.
set -eu

HELLO_SRC="$(dirname "$0")/sparkdash-set-clock"
HELLO_DST=/usr/local/bin/sparkdash-set-clock
SUDOERS_DST=/etc/sudoers.d/sparkdash-clock
CLOCK_USER=${SPARKDASH_CLOCK_USER:-sparkdash-clock}

[ "$(id -u)" -eq 0 ] || { echo "run as root (sudo)" >&2; exit 1; }

# 1. Helper binary.
if [ -f "$HELLO_SRC" ]; then
  install -m 0755 "$HELLO_SRC" "$HELLO_DST"
else
  echo "helper source not found next to installer ($HELLO_SRC); aborting" >&2
  exit 1
fi

# 2. Dedicated service user (review: "one dedicated user, not %sudo / ALL ALL").
#    Created as a locked-password system account; the dashboard's Spark SSH
#    login for clock control is this user. Re-running is idempotent.
if ! id "$CLOCK_USER" >/dev/null 2>&1; then
  useradd --system --shell /usr/sbin/nologin --home-dir /nonexistent "$CLOCK_USER"
  echo "created system user: $CLOCK_USER"
fi

# 3. Scoped sudoers drop-in: dedicated user, this binary only, exact argv.
#    The bare binary is allowed solely for the availability probe (prints
#    usage, exits 1 — changes nothing). Every other pin is one complete
#    flag set the server emits; none ends in a bare `*`.
TMP=$(mktemp /tmp/sparkdash-clock.XXXXXX)
trap 'rm -f "$TMP"' EXIT
cat > "$TMP" <<SUDOERS
# Managed by sparkDash install-clock-helper.sh — scoped clock-control grant.
# User: $CLOCK_USER (dedicated dashboard service account, locked password).
# Pinned argv: the ONLY forms this user may run. No trailing wildcards.
# Remove this file to revoke clock control.
Cmnd_Alias SPARKDASH_CLOCK_CMDS = \\
  $HELLO_DST, \\
  $HELLO_DST --domain cpu-big --unlock --persist, \\
  $HELLO_DST --domain cpu-big --unlock --no-persist, \\
  $HELLO_DST --domain cpu-big --max-mhz [0-9]* --persist, \\
  $HELLO_DST --domain cpu-big --max-mhz [0-9]* --no-persist, \\
  $HELLO_DST --domain cpu-little --unlock --persist, \\
  $HELLO_DST --domain cpu-little --unlock --no-persist, \\
  $HELLO_DST --domain cpu-little --max-mhz [0-9]* --persist, \\
  $HELLO_DST --domain cpu-little --max-mhz [0-9]* --no-persist, \\
  $HELLO_DST --domain gpu --unlock --persist, \\
  $HELLO_DST --domain gpu --unlock --no-persist, \\
  $HELLO_DST --domain gpu --max-mhz [0-9]* --persist, \\
  $HELLO_DST --domain gpu --max-mhz [0-9]* --no-persist
$CLOCK_USER ALL=(root) NOPASSWD: SPARKDASH_CLOCK_CMDS
SUDOERS

# Validate before installing; never leave a broken sudoers file behind.
visudo -c -f "$TMP" >/dev/null
install -m 0440 "$TMP" "$SUDOERS_DST"

echo "installed $HELLO_DST and $SUDOERS_DST (grant: $CLOCK_USER)"
echo "point the Spark's dashboard SSH user at: $CLOCK_USER"
echo "verify as that user: sudo -n -u $CLOCK_USER ssh -o BatchMode=yes localhost true 2>/dev/null; ssh $CLOCK_USER@<host> 'sudo -n $HELLO_DST --domain gpu --unlock --no-persist'"
