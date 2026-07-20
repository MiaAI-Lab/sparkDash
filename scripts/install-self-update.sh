#!/usr/bin/env bash
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
SCHEDULE="${SPARKDASH_UPDATE_TIME:-03:15}"
RESTART_CMD="${SPARKDASH_RESTART_CMD:-docker compose up --build -d}"
HOUR="${SCHEDULE%:*}"
MINUTE="${SCHEDULE#*:}"

if [[ "$(uname -s)" == "Darwin" ]]; then
  LABEL="com.sparkdash.self-update"
  PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
  LOG_DIR="$REPO/logs"
  mkdir -p "$HOME/Library/LaunchAgents" "$LOG_DIR"
  cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>$LABEL</string>
<key>ProgramArguments</key><array><string>$REPO/scripts/self-update.sh</string></array>
<key>WorkingDirectory</key><string>$REPO</string>
<key>EnvironmentVariables</key><dict>
<key>SPARKDASH_RESTART_CMD</key><string>$RESTART_CMD</string>
</dict>
<key>StartCalendarInterval</key><dict><key>Hour</key><integer>$((10#$HOUR))</integer><key>Minute</key><integer>$((10#$MINUTE))</integer></dict>
<key>StandardOutPath</key><string>$LOG_DIR/self-update.log</string>
<key>StandardErrorPath</key><string>$LOG_DIR/self-update-error.log</string>
</dict></plist>
EOF
  plutil -lint "$PLIST"
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$PLIST"
  echo "Installed $LABEL for daily update at $SCHEDULE"
  exit 0
fi

if command -v systemctl >/dev/null 2>&1; then
  UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
  mkdir -p "$UNIT_DIR"
  cat > "$UNIT_DIR/sparkdash-self-update.service" <<EOF
[Unit]
Description=Update and redeploy sparkDash
[Service]
Type=oneshot
WorkingDirectory=$REPO
Environment="SPARKDASH_RESTART_CMD=$RESTART_CMD"
ExecStart=$REPO/scripts/self-update.sh
EOF
  cat > "$UNIT_DIR/sparkdash-self-update.timer" <<EOF
[Unit]
Description=Run sparkDash updater daily
[Timer]
OnCalendar=*-*-* $SCHEDULE:00
Persistent=true
[Install]
WantedBy=timers.target
EOF
  systemctl --user daemon-reload
  systemctl --user enable --now sparkdash-self-update.timer
  echo "Installed systemd user timer for daily update at $SCHEDULE"
  exit 0
fi

echo "Unsupported service manager: expected launchd or systemd" >&2
exit 1
