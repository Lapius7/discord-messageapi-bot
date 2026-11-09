import { dget, reply } from "./discord";
import { internal } from "./internal";
import type { Env } from "./types";

const mb = (n: number) => (Number(n) / 1e6 >= 1000 ? `${(Number(n) / 1e9).toFixed(2)}GB` : `${(Number(n) / 1e6).toFixed(1)}MB`);
const num = (n: unknown) => Number(n ?? 0).toLocaleString("en-US");

async function name(env: Env, path: string, fallback: string) {
  try { return (await dget<{ name: string }>(env, path)).name; } catch { return fallback; }
}

/** 運営者専用。本文は一切表示しない。 */
export async function adminReply(env: Env, i: any) {
  const uid = String(i.member?.user?.id ?? i.user?.id ?? "");
  if (!env.ADMIN_USER_ID || uid !== env.ADMIN_USER_ID) return reply("このコマンドは運営者だけが使えます。");

  const api = internal(env);
  const sub = i.data?.options?.[0];
  const get = async <T>(path: string): Promise<T | null> => {
    const r = await api.json("GET", path);
    return r.ok ? r.json<T>() : null;
  };

  switch (sub?.name) {
    case "stats": {
      const s = await get<any>("/admin/stats");
      if (!s) return reply("集計を取得できませんでした。");
      const act = (a: string) => s.actions.find((x: any) => x.action === a) ?? { n: 0, d1: 0, d7: 0 };
      const line = (label: string, a: string) => { const x = act(a); return `${label}: 累計 ${num(x.n)} / 24時間 ${num(x.d1)} / 7日 ${num(x.d7)}`; };
      return reply([
        "**全体**",
        `サーバー ${num(s.guilds)} / チャンネル ${num(s.channels)}(有効なキーあり ${num(s.active_channels)})/ 有効なキー ${num(s.active_keys)}`,
        `本文 ${num(s.messages)} 件 / 画像 ${num(s.files_stored)} 枚保存(記録 ${num(s.files)} 枚)/ 容量 ${mb(s.bytes)}`,
        line("/connect(キー発行)", "key_issued"),
        line("キー失効", "key_revoked"),
        line("/disconnect", "channel_deleted"),
      ].join("\n"));
    }
    case "guilds": {
      const rows = await get<any[]>("/admin/guilds");
      if (!rows) return reply("集計を取得できませんでした。");
      const names = await Promise.all(rows.map((r) => name(env, `/guilds/${r.guild_id}`, "(取得不可)")));
      return reply("**サーバー別(本文数の上位)**\n" + (rows.map((r, n) =>
        `${names[n]} \`${r.guild_id}\`: ch ${num(r.channels)} / 本文 ${num(r.messages)} / 画像 ${num(r.files)} / ${mb(r.bytes)}`).join("\n") || "なし"));
    }
    case "channels": {
      const g = sub.options?.find((o: any) => o.name === "guild")?.value;
      const rows = await get<any[]>(`/admin/channels${g ? `?guild=${encodeURIComponent(String(g))}` : ""}`);
      if (!rows) return reply("集計を取得できませんでした。サーバーIDを確認してください。");
      const names = await Promise.all(rows.map((r) => name(env, `/channels/${r.channel_id}`, "(取得不可)")));
      return reply("**チャンネル別(本文数の上位)**\n" + (rows.map((r, n) =>
        `#${names[n]} \`${r.channel_id}\`(サーバー \`${r.guild_id}\`): 本文 ${num(r.messages)} / 画像 ${num(r.files)} / ${mb(r.bytes)} / キー ${num(r.active_keys)}${Number(r.backfill_done) ? "" : " / 過去分取得中"}`).join("\n") || "なし"));
    }
    case "audit": {
      const rows = await get<any[]>("/admin/audit");
      if (!rows) return reply("記録を取得できませんでした。");
      return reply("**直近の操作(UTC)**\n" + (rows.map((r) =>
        `${String(r.at).slice(0, 19).replace("T", " ")} ${r.action} ch \`${r.channel_id ?? "-"}\` by \`${r.actor}\``).join("\n") || "なし"));
    }
    default:
      return reply("stats / guilds / channels / audit のどれかを指定してください。");
  }
}
