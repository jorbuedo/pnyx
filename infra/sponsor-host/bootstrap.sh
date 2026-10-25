#!/usr/bin/env bash
# Prepare a fresh box to host the sponsor wallet. Run once, as root, on the VPS.
#
#   scp infra/sponsor-host/bootstrap.sh root@<host>:/tmp/ && ssh root@<host> bash /tmp/bootstrap.sh
#
# Installs bun and cloudflared, creates the service user and the directories, and closes the box down to
# outbound-only plus ssh. It writes no secrets — see README.md for the three that follow.
set -euo pipefail

SERVICE_USER=sponsor
CODE_DIR=/opt/sponsor
STATE_DIR=/var/lib/sponsor
CONF_DIR=/etc/sponsor
BUN_DIR=/usr/local/lib/bun

[[ "$(id -u)" == "0" ]] || { echo "run as root" >&2; exit 1; }

echo "==> packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl unzip rsync ufw unattended-upgrades sudo
# Written out rather than left to `dpkg-reconfigure`, whose noninteractive default does not reliably turn
# the timers on — a box that silently never patches itself is the failure mode worth ruling out.
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF

echo "==> service user"
id -u "$SERVICE_USER" >/dev/null 2>&1 || adduser --disabled-password --gecos "" "$SERVICE_USER"
install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 0755 "$CODE_DIR" "$STATE_DIR"
install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 0700 "$CONF_DIR"
# Reading its own service's logs needs no privilege beyond this.
usermod -aG systemd-journal "$SERVICE_USER"

echo "==> scoped sudo for the deploy user"
# This account has no password (--disabled-password), so a plain `sudo` group membership would be
# unusable rather than merely broad — and push.sh has to restart the service non-interactively. Grant
# exactly the unit actions, spelled with the .service suffix because sudoers matches the literal
# command line and `restart sponsor` is a different string from `restart sponsor.service`.
#
# ⚠️ `sponsor@*` is a **wildcard over instance names**, which is what a templated unit needs — one entry
# per network would have to be edited every time a network is added, and the thing being granted is the
# same five actions either way. It cannot widen beyond this template: `sponsor@` is a literal prefix.
sudoers=/etc/sudoers.d/sponsor
cat > /tmp/sponsor-sudoers <<EOF
$SERVICE_USER ALL=(root) NOPASSWD: /usr/bin/systemctl start sponsor-router.service, /usr/bin/systemctl stop sponsor-router.service, /usr/bin/systemctl restart sponsor-router.service, /usr/bin/systemctl enable sponsor-router.service, /usr/bin/systemctl disable sponsor-router.service, /usr/bin/systemctl start sponsor@*, /usr/bin/systemctl stop sponsor@*, /usr/bin/systemctl restart sponsor@*, /usr/bin/systemctl enable sponsor@*, /usr/bin/systemctl disable sponsor@*
EOF
visudo -cqf /tmp/sponsor-sudoers
install -m 0440 -o root -g root /tmp/sponsor-sudoers "$sudoers"
rm -f /tmp/sponsor-sudoers

# Carry root's authorized_keys over: some providers only inject an ssh key during an image install, so on an
# already-running box the key arrives by ssh-copy-id to root and would otherwise stop there.
if [[ -f /root/.ssh/authorized_keys ]]; then
  echo "==> copying root's authorized_keys to $SERVICE_USER"
  install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 0700 "/home/$SERVICE_USER/.ssh"
  install -o "$SERVICE_USER" -g "$SERVICE_USER" -m 0600 /root/.ssh/authorized_keys "/home/$SERVICE_USER/.ssh/authorized_keys"
else
  echo "!! /root/.ssh/authorized_keys is missing — add a key for $SERVICE_USER before locking ssh down"
fi

echo "==> bun"
# Installed outside /home so the unit can run with ProtectHome=yes.
if [[ ! -x "$BUN_DIR/bin/bun" ]]; then
  BUN_INSTALL="$BUN_DIR" bash -c "$(curl -fsSL https://bun.sh/install)"
fi
ln -sfn "$BUN_DIR/bin/bun" /usr/local/bin/bun
bun --version

echo "==> cloudflared"
if ! command -v cloudflared >/dev/null 2>&1; then
  arch="$(dpkg --print-architecture)"
  curl -fsSL -o /tmp/cloudflared.deb \
    "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${arch}.deb"
  dpkg -i /tmp/cloudflared.deb
  rm -f /tmp/cloudflared.deb
fi
cloudflared --version

echo "==> firewall"
# The sponsor listens on 127.0.0.1 and cloudflared dials out, so nothing but ssh needs to reach the box.
ufw --force reset >/dev/null
ufw default deny incoming
ufw default allow outgoing
# Before `enable`, so resetting the firewall over ssh cannot lock us out.
ufw allow OpenSSH || ufw allow 22/tcp
ufw --force enable
ufw status verbose

echo "==> systemd units"
# The templated wallet unit and the router in front of it. Installed, not enabled: which networks this
# host serves is a deployment decision and the env files have to exist first.
for unit in sponsor@.service sponsor-router.service; do
  install -m 0644 "$(dirname "$0")/$unit" "/etc/systemd/system/$unit" 2>/dev/null \
    || echo "!! $unit not next to this script — copy it to /etc/systemd/system/ yourself"
done
# The pre-2026-08-28 single-network unit. Removed rather than left disabled: it reads the shared env file,
# which no longer carries MIDNIGHT_NETWORK or a port, so starting it now would boot a second wallet on
# whatever the router already serves.
if [ -f /etc/systemd/system/sponsor.service ]; then
  echo "==> retiring the single-network sponsor.service"
  systemctl disable --now sponsor.service 2>/dev/null || true
  rm -f /etc/systemd/system/sponsor.service
fi
systemctl daemon-reload

# The journal is the only record of what this host spent DUST on, so its retention is declared rather
# than inherited. Skipped without complaint if the file is absent: it is a policy, not a prerequisite.
if [ -f "$(dirname "$0")/journald-sponsor.conf" ]; then
  echo "==> journal retention"
  install -d -m 0755 /etc/systemd/journald.conf.d
  install -m 0644 "$(dirname "$0")/journald-sponsor.conf" /etc/systemd/journald.conf.d/10-sponsor.conf
  systemctl restart systemd-journald
fi

cat <<EOF

Done. Still to do by hand, because each one is a secret or a token:

  1. $CONF_DIR/sponsor-seed          — a BIP-39 mnemonic, chmod 0600, owned by $SERVICE_USER.
                                       One seed for every network: the same mnemonic is a different
                                       wallet on each chain.
  2. $CONF_DIR/sponsor.env           — from deploy/sponsor.env.example (shared: token, origin, policy)
  3. $CONF_DIR/sponsor.router.env    — from deploy/sponsor.router.env.example
  4. $CONF_DIR/sponsor.<network>.env — one per network you serve, from
                                       deploy/sponsor.<network>.env.example
  5. cloudflared                     — point the tunnel at 127.0.0.1:3400 (the router). See
                                       deploy/README.md

All chmod 0600, owned by $SERVICE_USER. Then, from the repo on your machine:

  SPONSOR_SSH=$SERVICE_USER@$(hostname -f 2>/dev/null || hostname) infra/sponsor-host/push.sh

Then enable what this host serves, and bring a cold network up ON ITS OWN — a snapshot-less sync
saturates a core and there are two:

  systemctl enable --now sponsor-router.service
  systemctl enable --now sponsor@preprod.service     # then wait for /health to report it ok
  systemctl enable --now sponsor@preview.service
  systemctl enable --now sponsor@mainnet.service

  curl -s localhost:3400/health | jq

Lock ssh down once you have confirmed key auth works as $SERVICE_USER — a drop-in rather than an edit to
sshd_config, so a package upgrade cannot quietly revert it:

  printf 'PasswordAuthentication no\nPermitRootLogin no\n' > /etc/ssh/sshd_config.d/99-hardening.conf
  sshd -t && systemctl reload ssh
EOF
