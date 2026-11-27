#!/bin/sh
# Opt-in install of the root Mac collector. An ordinary user runs this; sudo
# prompts for the copy and launchctl bootstrap. The user LaunchAgent is not
# read or written.
set -eu

STORAGE_CATEGORIES=0
for arg in "$@"; do
  case "$arg" in
    --storage-categories)
      STORAGE_CATEGORIES=1
      ;;
    *)
      echo "usage: $0 [--storage-categories]" >&2
      exit 2
      ;;
  esac
done

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname "$0")" && pwd)
REPO_ROOT=$(CDPATH='' cd -- "$SCRIPT_DIR/../.." && pwd)
LABEL=ai.onyx.sparkdash-mac-agent.privileged
TEMPLATE="$SCRIPT_DIR/ai.onyx.sparkdash-mac-agent.privileged.plist"
DEST="/Library/LaunchDaemons/${LABEL}.plist"
INSTALL_DIR="/Library/Application Support/ai.onyx.sparkdash-mac-agent"
HELPER="$SCRIPT_DIR/privileged_collector_install.py"
USER_AGENT="${HOME:-}/Library/LaunchAgents/ai.onyx.sparkdash-mac-agent.plist"

if [ ! -f "$TEMPLATE" ]; then
  echo "missing plist template: $TEMPLATE" >&2
  exit 1
fi

echo "Installing $LABEL from $REPO_ROOT"
echo "This asks for sudo to copy a LaunchDaemon and bootstrap it."
echo "It does not modify the user LaunchAgent${USER_AGENT:+ at $USER_AGENT}."
if [ -n "${HOME:-}" ] && [ -f "$USER_AGENT" ]; then
  echo "User agent is installed and will be left running on its own port."
fi

TMP=$(mktemp "${TMPDIR:-/tmp}/sparkdash-mac-agent-privileged.XXXXXX.plist")
trap 'rm -f "$TMP"' EXIT
if [ "$STORAGE_CATEGORIES" -eq 1 ]; then
  /usr/bin/python3 -I "$HELPER" plist "$TEMPLATE" "$INSTALL_DIR" --storage-categories > "$TMP"
else
  /usr/bin/python3 -I "$HELPER" plist "$TEMPLATE" "$INSTALL_DIR" > "$TMP"
fi
plutil -lint "$TMP"

sudo -v
. "$SCRIPT_DIR/privileged-service-state.sh"
privileged_service_state "$LABEL"
sudo -n /usr/bin/python3 -I "$HELPER" install "$SCRIPT_DIR" "$INSTALL_DIR" "$TMP" "$DEST"
if [ "$SERVICE_STATE" = loaded ]; then
  sudo -n launchctl bootout "system/${LABEL}"
fi
sudo -n launchctl enable "system/${LABEL}"
sudo -n launchctl bootstrap system "$DEST"
sudo -n launchctl kickstart -k "system/${LABEL}"
sudo -n launchctl print "system/${LABEL}" >/dev/null
echo "Privileged collector is on http://127.0.0.1:8791/metrics"
echo "Point the sparkDash Mac node agent port at 8791 to read temperatures."
if [ "$STORAGE_CATEGORIES" -eq 1 ]; then
  echo "Storage categories enabled (works immediately; optional Full Disk Access helper: /usr/bin/python3 \"$INSTALL_DIR/sparkdash_mac_agent.py\" --setup-fda)"
fi
echo "Uninstall with: agents/macos/uninstall-privileged-collector.sh"
