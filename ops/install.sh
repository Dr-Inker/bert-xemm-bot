#!/usr/bin/env bash
set -euo pipefail
id -u bertxemm &>/dev/null || useradd --system --no-create-home --shell /usr/sbin/nologin bertxemm
mkdir -p /etc/bert-xemm-bot /var/lib/bert-xemm-bot /var/log/bert-xemm-bot
chown bertxemm:bertxemm /var/lib/bert-xemm-bot /var/log/bert-xemm-bot
chmod 0750 /etc/bert-xemm-bot /var/lib/bert-xemm-bot
[[ -f /etc/bert-xemm-bot/env ]] || install -m 0640 -o root -g bertxemm /dev/null /etc/bert-xemm-bot/env
cp /opt/bert-xemm-bot/systemd/bert-xemm-bot.service /etc/systemd/system/
cp /opt/bert-xemm-bot/ops/logrotate.conf /etc/logrotate.d/bert-xemm-bot
systemctl daemon-reload
echo "Installed. Populate /etc/bert-xemm-bot/config.yaml then: systemctl enable --now bert-xemm-bot"
