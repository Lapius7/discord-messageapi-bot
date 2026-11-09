import type { Env } from "./types";

const API = "https://discord.com/api/v10";
export const DISCORD_EPOCH = 1420070400000n;

/** 時刻から Snowflake を作る(この時刻以降のメッセージを after= で取るため) */
export const snowflakeFromMs = (ms: number) => ((BigInt(ms) - DISCORD_EPOCH) << 22n).toString();

export interface DMessage {
  id: string;
  content: string;
  timestamp: string;
  edited_timestamp: string | null;
  author: { id: string; username: string; global_name?: string | null };
  attachments: { id: string; filename: string; url: string; content_type?: string; size: number }[];
}

export class DiscordError extends Error {
  constructor(public status: number) { super(`discord ${status}`); }
}

export async function dget<T>(env: Env, path: string): Promise<T> {
  const r = await fetch(API + path, { headers: { authorization: `Bot ${env.DISCORD_BOT_TOKEN}`, "user-agent": "DiscordBot (discord-messageapi-bot, 1.0)" } });
  if (r.status === 429) throw new DiscordError(429);
  if (!r.ok) throw new DiscordError(r.status);
  return r.json() as Promise<T>;
}

export const fetchMessages = (env: Env, channelId: string, q: { after?: string; before?: string }) => {
  const p = new URLSearchParams({ limit: "100" });
  if (q.after) p.set("after", q.after);
  if (q.before) p.set("before", q.before);
  return dget<DMessage[]>(env, `/channels/${channelId}/messages?${p}`);
};

export const isStorableImage = (a: DMessage["attachments"][number]) =>
  /^image\/(png|jpeg|gif|webp)$/.test(a.content_type ?? "");

/** 内部 API の形式へ。画像以外の添付は保存しない。 */
export const toInternal = (m: DMessage) => ({
  id: m.id,
  author_id: m.author.id,
  author_name: m.author.global_name || m.author.username,
  content: m.content,
  posted_at: m.timestamp,
  edited_at: m.edited_timestamp,
  attachments: m.attachments.filter(isStorableImage).map((a) => ({ id: a.id, filename: a.filename })),
});

/** Discord の返信メッセージ(ephemeral) */
export const reply = (content: string) => ({ type: 4, data: { content, flags: 64, allowed_mentions: { parse: [] } } });
