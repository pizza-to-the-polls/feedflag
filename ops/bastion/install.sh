#!/bin/bash
# ops/bastion/install.sh — idempotent feedflag installer for the ops box
# (stack `pizza-eagle`, bastion.polls.pizza).
#
# feedflag is deployed out-of-band: its units are NOT in the pizza-eagle
# stack's user-data. After any instance replacement (type resize, AMI bump)
# run this once via SSM (runs as root):
#
#   B64=$(base64 < ops/bastion/install.sh | tr -d '\n')
#   aws ssm send-command --instance-ids <id> --document-name AWS-RunShellScript \
#     --parameters "commands=[\"echo $B64 | base64 -d | bash\"]"
#
# Safe to re-run any time: refreshes units from this checkout, syncs .env
# from Secrets Manager, reloads systemd. Identical unit files → no-op.
#
# 2026-10-31 election-night wedge context: a peak leg spun a full core
# holding the run-lock until a manual EC2 reboot; memory pressure OOM'd
# the SSM agent + pizza-eagle and stranded the Retool tunnel. The units
# this installs carry the anti-wedge hardening (TimeoutStartSec/MemoryMax,
# see ops/bastion/README.md §hardening).
set -uo pipefail
cd /opt/feedflag

# Code: this checkout is a deployed artifact of main (run-timer.sh ff-pulls
# each fire anyway; reset here so a replaced box starts from main exactly).
git fetch -q origin main
git reset --hard origin/main

# .env — machine credentials. Source of truth: Secrets Manager
# ptp/prod/feedflag/env (BotRole grants ptp/prod/feedflag/* reads).
if aws secretsmanager get-secret-value --secret-id ptp/prod/feedflag/env \
     --query SecretString --output text > /opt/feedflag/.env.new 2>/dev/null; then
  mv /opt/feedflag/.env.new /opt/feedflag/.env
else
  echo "[install] WARN: .env refresh failed — keeping current file" >&2
  rm -f /opt/feedflag/.env.new
  [ -f /opt/feedflag/.env ] || { echo "[install] FATAL: no .env and Secrets Manager read failed" >&2; exit 1; }
fi
chmod 600 /opt/feedflag/.env

[ -d node_modules ] || npm ci --omit=dev

install -m 644 -o root -g root \
  /opt/feedflag/ops/bastion/feedflag-*.service \
  /opt/feedflag/ops/bastion/feedflag-*.timer /etc/systemd/system/
systemctl daemon-reload
for t in peak social hot digest reactions heartbeat govwatch; do
  systemctl enable --now feedflag-$t.timer
done
systemctl list-timers --no-pager 'feedflag-*'