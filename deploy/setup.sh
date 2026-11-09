#!/usr/bin/env bash
# サーバー上で sudo 実行する初回セットアップ(冪等)。シークレットは表示しない。
set -euo pipefail
APP=/srv/discord-messageapi-bot
USER_=dcmapi
DB=discord_messageapi
ENVF=/etc/discord-messageapi/env

id "$USER_" &>/dev/null || useradd --system --home-dir "$APP" --shell /usr/sbin/nologin "$USER_"
install -d -o "$USER_" -g "$USER_" -m 750 "$APP" "$APP/internal" "$APP/storage"
install -d -m 755 /etc/discord-messageapi

if [ ! -f "$ENVF" ]; then
  DBPW=$(openssl rand -hex 24)
  SECRET=$(openssl rand -hex 32)
  mysql -e "CREATE DATABASE IF NOT EXISTS \`$DB\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
            CREATE USER IF NOT EXISTS '$USER_'@'localhost' IDENTIFIED BY '$DBPW';
            ALTER USER '$USER_'@'localhost' IDENTIFIED BY '$DBPW';
            GRANT SELECT,INSERT,UPDATE,DELETE ON \`$DB\`.* TO '$USER_'@'localhost';"
  umask 077
  cat > "$ENVF" <<EOF
INTERNAL_SECRET=$SECRET
DB_USER=$USER_
DB_PASSWORD=$DBPW
DB_NAME=$DB
STORAGE_DIR=$APP/storage
PORT=8787
HOST=127.0.0.1
EOF
  chown root:root "$ENVF"; chmod 600 "$ENVF"
fi

# スキーマ適用は管理者権限で(アプリ用ユーザーには CREATE を与えない)
[ -f "$APP/internal/schema.sql" ] && mysql "$DB" < "$APP/internal/schema.sql"

cat > /etc/systemd/system/discord-messageapi.service <<EOF
[Unit]
Description=discord-messageapi internal API
After=network.target mysql.service

[Service]
User=$USER_
Group=$USER_
WorkingDirectory=$APP/internal
EnvironmentFile=$ENVF
ExecStart=/usr/local/bin/bun src/index.ts
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
PrivateDevices=true
ProtectKernelTunables=true
ProtectControlGroups=true
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
CapabilityBoundingSet=
ReadWritePaths=$APP/storage

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable discord-messageapi >/dev/null
echo setup-ok
