export {};
// 使い方: DISCORD_APP_ID=... DISCORD_BOT_TOKEN=... bun scripts/register-commands.ts
const { DISCORD_APP_ID: app, DISCORD_BOT_TOKEN: token } = process.env;
if (!app || !token) throw new Error("DISCORD_APP_ID / DISCORD_BOT_TOKEN が必要です");

const base = { default_member_permissions: "16", dm_permission: false, contexts: [0], integration_types: [0] };
const commands = [
  { name: "connect", description: "このチャンネルの本文と画像を取得するキーを発行します", ...base },
  { name: "keys", description: "このチャンネルのキー一覧を表示します", ...base },
  { name: "revoke", description: "このチャンネルのキーを失効します", ...base },
  { name: "disconnect", description: "キーを失効し、保存した本文と画像をすべて削除します", ...base },

  // 運営者専用。実行できるかは Worker 側で ADMIN_USER_ID と照合する
  {
    name: "admin", description: "運営者向けの統計を表示します", default_member_permissions: "0", contexts: [0, 1], integration_types: [0],
    options: [
      { type: 1, name: "stats", description: "全体の集計" },
      { type: 1, name: "guilds", description: "サーバーごとの集計(上位15)" },
      { type: 1, name: "channels", description: "チャンネルごとの集計(上位15)", options: [{ type: 3, name: "guild", description: "サーバーID(省略で全体)" }] },
      { type: 1, name: "audit", description: "直近の操作の記録" },
    ],
  },
];
const r = await fetch(`https://discord.com/api/v10/applications/${app}/commands`, {
  method: "PUT",
  headers: { authorization: `Bot ${token}`, "content-type": "application/json" },
  body: JSON.stringify(commands),
});
console.log(r.status, r.ok ? "registered" : await r.text());
