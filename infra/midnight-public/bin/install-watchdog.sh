#!/bin/zsh
# Install the height watchdog as a boot LaunchDaemon that fires every 5 minutes. Run with sudo.
#
# Separate from provision-sudo.sh on purpose: that script repurposes a fresh Mac and does four other
# things, and this needs to be installable on the box that is already running.
#
# A LaunchDaemon with UserName rather than a LaunchAgent, matching ai.pnyx.midnight: podman belongs
# to the owning user, but the job has to survive a reboot with nobody logged in.
set -u
[[ $EUID -eq 0 ]] || { echo "run with sudo"; exit 1; }

# Defaults to whoever invoked sudo: under sudo `id -un` is root, so asking the caller to substitute
# the owner by hand is a footgun. An explicit argument still wins.
OWNER=${1:-${SUDO_USER:-}}
[[ -n "$OWNER" && "$OWNER" != "root" ]] \
  || { echo "usage: sudo install-watchdog.sh [owning-user]   (no SUDO_USER to fall back on)"; exit 1; }
OWNER_HOME=$(eval echo "~$OWNER")
[[ -d "$OWNER_HOME/pnyx-midnight" ]] || { echo "no $OWNER_HOME/pnyx-midnight -- wrong user?"; exit 1; }
[[ -f "$OWNER_HOME/pnyx-midnight/run-height-watchdog.ts" ]] \
  || { echo "push run-height-watchdog.ts to $OWNER_HOME/pnyx-midnight/ first"; exit 1; }
BUN=$(sudo -u "$OWNER" sh -lc 'command -v bun') \
  || { echo "bun not on $OWNER's PATH"; exit 1; }

cat > /Library/LaunchDaemons/ai.pnyx.watchdog.plist <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>ai.pnyx.watchdog</string>
  <key>ProgramArguments</key>
  <array>
    <string>$BUN</string>
    <string>$OWNER_HOME/pnyx-midnight/run-height-watchdog.ts</string>
  </array>
  <key>UserName</key><string>$OWNER</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key><string>$OWNER_HOME</string>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>StartInterval</key><integer>300</integer>
  <key>RunAtLoad</key><false/>
  <key>StandardOutPath</key><string>$OWNER_HOME/pnyx-midnight/log/watchdog.log</string>
  <key>StandardErrorPath</key><string>$OWNER_HOME/pnyx-midnight/log/watchdog.log</string>
</dict>
</plist>
PLIST
chown root:wheel /Library/LaunchDaemons/ai.pnyx.watchdog.plist
chmod 644 /Library/LaunchDaemons/ai.pnyx.watchdog.plist
launchctl bootout system/ai.pnyx.watchdog 2>/dev/null
launchctl bootstrap system /Library/LaunchDaemons/ai.pnyx.watchdog.plist || { echo "bootstrap failed"; exit 1; }
echo "installed: ai.pnyx.watchdog, every 300s"
echo
echo "  tail -f $OWNER_HOME/pnyx-midnight/log/watchdog.log"
echo "  sudo launchctl kickstart system/ai.pnyx.watchdog   # run one check now"
echo "  sudo launchctl bootout  system/ai.pnyx.watchdog    # stop it"
echo
echo "RunAtLoad is false deliberately: at boot the podman VM is not up yet, so the first check"
echo "would read an unreadable height and log a warning for nothing. The first real check is +5 min."
