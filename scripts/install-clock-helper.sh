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
#   2. /etc/sudoers.d/sparkdash-clock      (scoped NOPASSWD for that binary only)
#
# The sudoers drop-in is validated with visudo -c BEFORE installation and is
# limited to exactly one command — never blanket sudo, never /etc/sudoers.
set -eu

HELLO_SRC="$(dirname "$0")/sparkdash-set-clock"
HELLO_DST=/usr/local/bin/sparkdash-set-clock
SUDOERS_DST=/etc/sudoers.d/sparkdash-clock

[ "$(id -u)" -eq 0 ] || { echo "run as root (sudo)" >&2; exit 1; }

# 1. Helper binary.
if [ -f "$HELLO_SRC" ]; then
  install -m 0755 "$HELLO_SRC" "$HELLO_DST"
else
  echo "helper source not found next to installer ($HELLO_SRC); aborting" >&2
  exit 1
fi

# 2. Scoped sudoers drop-in. Percent-escape nothing: the rule grants exactly
#    one command with no arguments and no runas aliases.
TMP=$(mktemp /tmp/sparkdash-clock.XXXXXX)
trap 'rm -f "$TMP"' EXIT
cat > "$TMP" <<SUDOERS
# Managed by sparkDash install-clock-helper.sh — scoped clock-control grant.
# Allows the SSH user group to run ONLY the sparkDash clock helper with
# passwordless sudo. Remove this file to revoke clock control.
%sudo ALL=(root) NOPASSWD: $HELLO_DST
SUDOERS

# Validate before installing; never leave a broken sudoers file behind.
visudo -c -f "$TMP" >/dev/null
install -m 0440 "$TMP" "$SUDOERS_DST"

echo "installed $HELLO_DST and $SUDOERS_DST"
echo "verify from the dashboard host: ssh <user>@<host> 'sudo -n $HELLO_DST --help'"
