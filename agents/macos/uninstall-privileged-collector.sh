#!/bin/sh
# Undo install-privileged-collector.sh. An ordinary user runs this; sudo
# prompts to bootout and delete the LaunchDaemon. The user LaunchAgent is
# not stopped or removed.
set -eu

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname "$0")" && pwd)
LABEL=ai.onyx.sparkdash-mac-agent.privileged
DEST="/Library/LaunchDaemons/${LABEL}.plist"
USER_AGENT="${HOME:-}/Library/LaunchAgents/ai.onyx.sparkdash-mac-agent.plist"

echo "Removing $LABEL. The user LaunchAgent is not touched."
if [ -n "${HOME:-}" ] && [ -f "$USER_AGENT" ]; then
  echo "Leaving $USER_AGENT in place."
fi

sudo -v
. "$SCRIPT_DIR/privileged-service-state.sh"
privileged_service_state "$LABEL"
if [ "$SERVICE_STATE" = loaded ]; then
  sudo -n launchctl bootout "system/${LABEL}"
fi
privileged_service_state "$LABEL"
if [ "$SERVICE_STATE" = loaded ]; then
  echo "Privileged collector is still loaded; refusing to remove its plist." >&2
  exit 1
fi
sudo -n rm -f "$DEST"
echo "Privileged collector removed. The user agent, if installed, is unchanged."
