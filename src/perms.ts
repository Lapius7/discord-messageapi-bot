import { DiscordError, dget } from "./discord";
import type { Env } from "./types";

const ADMINISTRATOR = 1n << 3n;
const VIEW_CHANNEL = 1n << 10n;
const READ_HISTORY = 1n << 16n;
const NEED = VIEW_CHANNEL | READ_HISTORY;

interface Role { id: string; permissions: string }
interface Overwrite { id: string; type: number; allow: string; deny: string }

/** Discord の権限計算(公式の手順どおり)。発行者が「見る」と「履歴を読む」の両方を持つか。 */
export function canRead(o: {
  guildId: string; ownerId: string; userId: string; memberRoles: string[];
  roles: Role[]; overwrites: Overwrite[];
}): boolean {
  if (o.userId === o.ownerId) return true;
  const roleOf = (id: string) => BigInt(o.roles.find((r) => r.id === id)?.permissions ?? "0");
  let p = roleOf(o.guildId); // @everyone
  for (const r of o.memberRoles) p |= roleOf(r);
  if (p & ADMINISTRATOR) return true;

  const ow = (id: string) => o.overwrites.find((x) => x.id === id);
  const ev = ow(o.guildId);
  if (ev) p = (p & ~BigInt(ev.deny)) | BigInt(ev.allow);
  let deny = 0n, allow = 0n;
  for (const r of o.memberRoles) {
    const x = o.overwrites.find((y) => y.id === r && y.type === 0);
    if (x) { deny |= BigInt(x.deny); allow |= BigInt(x.allow); }
  }
  p = (p & ~deny) | allow;
  const me = o.overwrites.find((y) => y.id === o.userId && y.type === 1);
  if (me) p = (p & ~BigInt(me.deny)) | BigInt(me.allow);
  return (p & NEED) === NEED;
}

/**
 * 発行者がまだチャンネルを読めるか。
 * true/false は確定した結果。確かめられなかったとき(Discord の一時的な障害)は null を返す。
 * 結果は 5 分間キャッシュする。
 */
export async function issuerCanRead(env: Env, guildId: string, channelId: string, userId: string): Promise<boolean | null> {
  const cache = (caches as any).default as Cache;
  const ck = new Request(`https://perm-cache.invalid/${channelId}/${userId}`);
  const hit = await cache.match(ck);
  if (hit) return (await hit.text()) === "1";

  try {
    const [guild, roles, ch] = await Promise.all([
      dget<{ owner_id: string }>(env, `/guilds/${guildId}`),
      dget<Role[]>(env, `/guilds/${guildId}/roles`),
      dget<{ type: number; parent_id?: string; permission_overwrites?: Overwrite[] }>(env, `/channels/${channelId}`),
    ]);
    let overwrites = ch.permission_overwrites ?? [];
    // スレッドは親チャンネルの権限を引き継ぐ
    if ([10, 11, 12].includes(ch.type) && ch.parent_id) {
      overwrites = (await dget<{ permission_overwrites?: Overwrite[] }>(env, `/channels/${ch.parent_id}`)).permission_overwrites ?? [];
    }
    let member: { roles: string[] };
    try {
      member = await dget<{ roles: string[] }>(env, `/guilds/${guildId}/members/${userId}`);
    } catch (e) {
      if (e instanceof DiscordError && e.status === 404) return remember(cache, ck, false); // サーバーを抜けた
      throw e;
    }
    return remember(cache, ck, canRead({ guildId, ownerId: guild.owner_id, userId, memberRoles: member.roles, roles, overwrites }));
  } catch (e) {
    // Bot がサーバーやチャンネルを見られない(403・404)ときも、キーは使えない扱いにする
    if (e instanceof DiscordError && (e.status === 403 || e.status === 404)) return remember(cache, ck, false);
    return null;
  }
}

async function remember(cache: Cache, ck: Request, ok: boolean) {
  await cache.put(ck, new Response(ok ? "1" : "0", { headers: { "cache-control": "max-age=300" } }));
  return ok;
}
