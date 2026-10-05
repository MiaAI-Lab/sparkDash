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
# Review requirement (PR #98): the grant is NOT `%sudo ... NOPASSWD: <bin>`
# with an open argv — that let every sudo user run the helper with any
# argument it accepts. Here the grant is pinned to the exact argv prefixes
# the server sends, so no other flag (and no flagless run) is possible.
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

# 2. Scoped sudoers drop-in: this binary only, pinned argv prefixes.
#    Each line authorizes exactly one domain with any of the server's value
#    flags after it. The bare binary is allowed solely for the install probe
#    (it prints usage and exits 1 — it changes nothing). Unknown long flags
#    (--persist-path etc.) can never be introduced: they don't match a pin.
TMP=$(mktemp /tmp/sparkdash-clock.XXXXXX)
trap 'rm -f "$TMP"' EXIT
cat > "$TMP" <<SUDOERS
# Managed by sparkDash install-clock-helper.sh — scoped clock-control grant.
# Pinned argv: the invoking user may run ONLY these domain-prefixed forms.
# Remove this file to revoke clock control.
Cmnd_Alias SPARKDASH_CLOCK_CMDS = \\
  $HELLO_DST, \\
  $HELLO_DST --domain cpu-big *, \\
  $HELLO_DST --domain cpu-little *, \\
  $HELLO_DST --domain gpu *, \\
  $HELLO_DST --domain cpu-big, \\
  $HELLO_DST --domain cpu-little, \\
  $HELLO_DST --domain gpu
ALL ALL=(root) NOPASSWD: SPARKDASH_CLOCK_CMDS
SUDOERS

# Validate before installing; never leave a broken sudoers file behind.
visudo -c -f "$TMP" >/dev/null
install -m 0440 "$TMP" "$SUDOERS_DST"

echo "installed $HELLO_DST and $SUDOERS_DST"
echo "verify from the dashboard host: ssh <user>@<host> 'sudo -n $HELLO_DST --domain gpu --unlock --no-persist'"
echo "  expected output: the helper's success/usage output (sudo allowed the pinned argv)"
