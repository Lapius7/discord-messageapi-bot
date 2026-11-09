#!/usr/bin/env bash
# 使い方: DCM_DEPLOY_HOST=<ssh のホスト名> bash deploy/deploy.sh
# internal/ をサーバーへ送り、スキーマ適用・再起動する。
set -euo pipefail
cd "$(dirname "$0")/.."
H=${DCM_DEPLOY_HOST:?DCM_DEPLOY_HOST に ssh のホスト名を指定してください}; APP=/srv/discord-messageapi-bot
rsync -a --delete --exclude node_modules --exclude storage internal/ "$H:/tmp/dcm-internal/"
scp -q deploy/setup.sh "$H:/tmp/dcm-setup.sh"
ssh "$H" "sudo rsync -a --delete --chown=dcmapi:dcmapi /tmp/dcm-internal/ $APP/internal/ \
  && sudo bash /tmp/dcm-setup.sh \
  && sudo -u dcmapi env HOME=/tmp BUN_INSTALL_CACHE_DIR=/tmp/bun-cache bash -c 'cd $APP/internal && /usr/local/bin/bun install --production 2>&1 | tail -1'; \
  sudo systemctl restart discord-messageapi; sleep 1; systemctl is-active discord-messageapi"
