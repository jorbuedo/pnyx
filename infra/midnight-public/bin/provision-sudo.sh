#!/bin/zsh
# Repurpose this Mac as the Pnyx Midnight indexer host. Everything here needs root; the
# non-root half (podman, images, the indexer container) is already in place.
#
#   ssh -t <the box> 'sudo ~/pnyx-midnight/bin/provision-sudo.sh'
#
# Idempotent: safe to run twice. Nothing is deleted — openclaw and ollama are stopped and
# disabled, not uninstalled, and the undo for each is printed at the end.
set -u

if [[ $EUID -ne 0 ]]; then
  echo "run me with sudo" >&2
  exit 1
fi
OWNER="${SUDO_USER:-}"
if [[ -z "$OWNER" ]]; then
  echo "run me through sudo (SUDO_USER must be set) so I know whose podman VM to start" >&2
  exit 1
fi
OWNER_UID=$(id -u "$OWNER")
OWNER_HOME=$(dscl . -read "/Users/$OWNER" NFSHomeDirectory | awk '{print $2}')
say() { print -r -- "
── $* ──"; }

say "1/4  stop openclaw"
if [[ -f /Library/LaunchDaemons/ai.openclaw.gateway.plist ]]; then
  launchctl bootout system/ai.openclaw.gateway 2>/dev/null && echo "  stopped" || echo "  was not running"
  launchctl disable system/ai.openclaw.gateway && echo "  disabled at boot"
else
  echo "  no ai.openclaw.gateway.plist — nothing to do"
fi
pkill -u openclaw -f openclaw-gateway 2>/dev/null && echo "  killed leftover gateway process"

say "2/4  stop ollama (it was holding ~21 GB of RAM)"
launchctl bootout "gui/$OWNER_UID/ai.ollama.serve" 2>/dev/null && echo "  stopped" || echo "  was not running"
launchctl disable "gui/$OWNER_UID/ai.ollama.serve" && echo "  disabled at login"

say "3/4  power settings for a machine that never sleeps"
pmset -a sleep 0 disablesleep 1 autorestart 1 powernap 0 womp 1 displaysleep 10
pmset -g | grep -E "^ *(sleep|disablesleep|autorestart|powernap|womp|displaysleep|hibernatemode)" | sed 's/^/  /'

say "4/4  start the indexer at BOOT, not at login"
cat > /Library/LaunchDaemons/ai.pnyx.midnight.plist <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>ai.pnyx.midnight</string>
  <key>ProgramArguments</key>
  <array><string>$OWNER_HOME/pnyx-midnight/bin/start.sh</string></array>
  <key>UserName</key><string>$OWNER</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key><string>$OWNER_HOME</string>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><false/>
  <key>StandardOutPath</key><string>$OWNER_HOME/pnyx-midnight/log/boot.out.log</string>
  <key>StandardErrorPath</key><string>$OWNER_HOME/pnyx-midnight/log/boot.err.log</string>
</dict>
</plist>
PLIST
chown root:wheel /Library/LaunchDaemons/ai.pnyx.midnight.plist
chmod 644 /Library/LaunchDaemons/ai.pnyx.midnight.plist
launchctl bootout system/ai.pnyx.midnight 2>/dev/null
launchctl bootstrap system /Library/LaunchDaemons/ai.pnyx.midnight.plist && echo "  LaunchDaemon installed"

# A boot-time daemon has no GUI session. Virtualization.framework usually does not care, but
# "usually" is not a test: ask the running system whether the indexer actually answers.
echo "  waiting up to 90s for the indexer to answer..."
ok=0
for i in {1..18}; do
  if curl -s -m 5 -X POST http://127.0.0.1:8088/api/v4/graphql \
       -H 'content-type: application/json' -d '{"query":"{ block { height } }"}' \
     | grep -q '"height"'; then ok=1; break; fi
  sleep 5
done
if [[ $ok -eq 1 ]]; then
  height=$(curl -s -m 5 -X POST http://127.0.0.1:8088/api/v4/graphql \
            -H 'content-type: application/json' -d '{"query":"{ block { height } }"}')
  echo "  indexer answering: $height"
  launchctl bootout "gui/$OWNER_UID/ai.pnyx.midnight" 2>/dev/null
  launchctl disable "gui/$OWNER_UID/ai.pnyx.midnight" 2>/dev/null
  echo "  login-time LaunchAgent retired; the boot daemon owns it now"
else
  echo "  !! the indexer is NOT answering under the boot daemon."
  echo "  !! Virtualization.framework likely wants a user session. Falling back to the"
  echo "  !! login agent — turn on auto-login in System Settings > Users & Groups."
  launchctl bootout system/ai.pnyx.midnight 2>/dev/null
  rm -f /Library/LaunchDaemons/ai.pnyx.midnight.plist
  launchctl enable "gui/$OWNER_UID/ai.pnyx.midnight" 2>/dev/null
  sudo -u "$OWNER" launchctl bootstrap "gui/$OWNER_UID" "$OWNER_HOME/Library/LaunchAgents/ai.pnyx.midnight.plist" 2>/dev/null
fi

say "undo, if you ever want any of this back"
cat <<UNDO
  openclaw : sudo launchctl enable system/ai.openclaw.gateway
             sudo launchctl bootstrap system /Library/LaunchDaemons/ai.openclaw.gateway.plist
  ollama   : launchctl enable gui/$OWNER_UID/ai.ollama.serve
             launchctl bootstrap gui/$OWNER_UID $OWNER_HOME/Library/LaunchAgents/ai.ollama.serve.plist
  power    : sudo pmset -a sleep 1 disablesleep 0 autorestart 0 powernap 1
  indexer  : sudo launchctl bootout system/ai.pnyx.midnight
UNDO
