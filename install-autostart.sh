#!/bin/sh
# Install (or remove with --uninstall) a launchd agent that starts the Taskmonitor server at login
# and restarts it if it exits.
set -eu

LABEL=com.taskmonitor.deck
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DIR=$(cd "$(dirname "$0")" && pwd)
NODE=${NODE:-$(command -v node)}
LOG="$HOME/Library/Logs/taskmonitor.log"
DOMAIN="gui/$(id -u)"

launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || :

if [ "${1:-}" = "--uninstall" ]; then
  rm -f "$PLIST"
  echo "Autostart entfernt."
  exit 0
fi

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE</string>
    <string>$DIR/server.js</string>
  </array>
  <key>WorkingDirectory</key><string>$DIR</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
EOF

launchctl bootstrap "$DOMAIN" "$PLIST"
echo "Autostart installiert ($PLIST), Log: $LOG"
