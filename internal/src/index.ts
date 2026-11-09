import { Hono } from "hono";
import { timingSafeEqual } from "node:crypto";
import { config } from "./config";
import { q, audit, pool } from "./db";
import { MIME, exists, isId, pathFor, removeChannelFiles, removeMessageFiles, saveStream } from "./storage";
import { purgeExpired } from "./purge";

const app = new Hono();

const safeEq = (a: string, b: string) => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

// Workers との共有シークレット。ここで必ず検証する。
app.use("*", async (c, next) => {
  if (!safeEq(c.req.header("x-internal-secret") ?? "", config.secret)) return c.json({ error: "unauthorized" }, 401);
  await next();
});

const bad = (c: any, m = "bad_request") => c.json({ error: m }, 400);
const isoToSql = (s: string) => new Date(s).toISOString().slice(0, 23).replace("T", " ");

// --- チャンネルとキー ---
app.post("/keys", async (c) => {
  const b = await c.req.json();
  if (![b.channel_id, b.guild_id, b.created_by].every((v) => isId(String(v))) || !/^[0-9a-f]{64}$/.test(b.key_hash)) return bad(c);
  // 新しいチャンネルの追加には上限がある(既存チャンネルのキー再発行は対象外)
  const [known] = await q("SELECT 1 AS x FROM channels WHERE channel_id = ?", [b.channel_id]);
  if (!known) {
    const [g] = await q("SELECT COUNT(*) AS n FROM channels WHERE guild_id = ?", [b.guild_id]);
    const [t] = await q("SELECT COUNT(*) AS n FROM channels");
    if (Number(g.n) >= config.maxChannelsPerGuild || Number(t.n) >= config.maxChannelsTotal) return c.json({ error: "quota" }, 429);
  }
  await q(
    `INSERT INTO channels (channel_id, guild_id, connected_by, created_at) VALUES (?,?,?,UTC_TIMESTAMP())
     ON DUPLICATE KEY UPDATE guild_id = VALUES(guild_id)`,
    [b.channel_id, b.guild_id, b.created_by],
  );
  // 1チャンネル1キー: 既存の有効キーは失効させてから発行
  await q("UPDATE api_keys SET revoked_at = UTC_TIMESTAMP() WHERE channel_id = ? AND revoked_at IS NULL", [b.channel_id]);
  await q(
    `INSERT INTO api_keys (channel_id, key_hash, key_prefix, created_by, created_at, expires_at)
     VALUES (?,?,?,?,UTC_TIMESTAMP(), DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? DAY))`,
    [b.channel_id, b.key_hash, String(b.key_prefix).slice(0, 12), b.created_by, Number(b.ttl_days ?? 30)],
  );
  await audit(String(b.created_by), "key_issued", b.channel_id);
  return c.json({ ok: true });
});

app.get("/keys/lookup/:hash", async (c) => {
  const h = c.req.param("hash");
  if (!/^[0-9a-f]{64}$/.test(h)) return bad(c);
  const [k] = await q(
    `SELECT k.id, k.channel_id, ch.guild_id, k.created_by, k.expires_at FROM api_keys k
     JOIN channels ch ON ch.channel_id = k.channel_id
     WHERE k.key_hash = ? AND k.revoked_at IS NULL AND k.expires_at > UTC_TIMESTAMP()`,
    [h],
  );
  return k ? c.json(k) : c.json({ error: "invalid_key" }, 404);
});

app.post("/keys/renew/:hash", async (c) => {
  const h = c.req.param("hash");
  if (!/^[0-9a-f]{64}$/.test(h)) return bad(c);
  await q(
    "UPDATE api_keys SET expires_at = DATE_ADD(UTC_TIMESTAMP(), INTERVAL 30 DAY) WHERE key_hash = ? AND revoked_at IS NULL AND expires_at > UTC_TIMESTAMP()",
    [h],
  );
  return c.json({ ok: true });
});

app.get("/channels/:cid/keys", async (c) => {
  const cid = c.req.param("cid");
  if (!isId(cid)) return bad(c);
  return c.json(await q(
    "SELECT id, key_prefix, created_by, created_at, expires_at, revoked_at FROM api_keys WHERE channel_id = ? ORDER BY id DESC LIMIT 20", [cid]));
});

app.post("/channels/:cid/revoke", async (c) => {
  const cid = c.req.param("cid");
  if (!isId(cid)) return bad(c);
  await q("UPDATE api_keys SET revoked_at = UTC_TIMESTAMP() WHERE channel_id = ? AND revoked_at IS NULL", [cid]);
  await audit(c.req.header("x-actor") ?? "system", "key_revoked", cid);
  return c.json({ ok: true });
});

// /disconnect: キー・本文・画像をすべて削除
app.delete("/channels/:cid", async (c) => {
  const cid = c.req.param("cid");
  if (!isId(cid)) return bad(c);
  await removeChannelFiles(cid);
  await q("DELETE FROM channels WHERE channel_id = ?", [cid]); // CASCADE
  await audit(c.req.header("x-actor") ?? "system", "channel_deleted", cid);
  return c.json({ ok: true });
});

// cron 用: 有効なキーを持つチャンネルの一覧
app.get("/channels", async (c) =>
  c.json(await q("SELECT ch.channel_id, ch.guild_id, MAX(k.created_by) AS created_by FROM channels ch JOIN api_keys k ON k.channel_id = ch.channel_id AND k.revoked_at IS NULL AND k.expires_at > UTC_TIMESTAMP() GROUP BY ch.channel_id, ch.guild_id ORDER BY MIN(ch.last_sync_at) IS NULL DESC, MIN(ch.last_sync_at) ASC")));

// --- 運営者向けの集計(本文は返さない) ---
app.get("/admin/stats", async (c) => {
  const [t] = await q(`SELECT
    (SELECT COUNT(DISTINCT guild_id) FROM channels) AS guilds,
    (SELECT COUNT(*) FROM channels) AS channels,
    (SELECT COUNT(DISTINCT channel_id) FROM api_keys WHERE revoked_at IS NULL AND expires_at > UTC_TIMESTAMP()) AS active_channels,
    (SELECT COUNT(*) FROM api_keys WHERE revoked_at IS NULL AND expires_at > UTC_TIMESTAMP()) AS active_keys,
    (SELECT COUNT(*) FROM messages) AS messages,
    (SELECT COUNT(*) FROM attachments) AS files,
    (SELECT COUNT(*) FROM attachments WHERE stored_at IS NOT NULL) AS files_stored,
    (SELECT COALESCE(SUM(size),0) FROM attachments) AS bytes`);
  const act = await q("SELECT action, COUNT(*) AS n, SUM(at > UTC_TIMESTAMP() - INTERVAL 1 DAY) AS d1, SUM(at > UTC_TIMESTAMP() - INTERVAL 7 DAY) AS d7 FROM audit_log GROUP BY action");
  return c.json({ ...t, actions: act });
});

app.get("/admin/guilds", async (c) =>
  c.json(await q(`SELECT ch.guild_id, COUNT(DISTINCT ch.channel_id) AS channels,
    (SELECT COUNT(*) FROM messages m JOIN channels x ON x.channel_id = m.channel_id WHERE x.guild_id = ch.guild_id) AS messages,
    (SELECT COUNT(*) FROM attachments a JOIN channels x ON x.channel_id = a.channel_id WHERE x.guild_id = ch.guild_id) AS files,
    (SELECT COALESCE(SUM(a.size),0) FROM attachments a JOIN channels x ON x.channel_id = a.channel_id WHERE x.guild_id = ch.guild_id) AS bytes
    FROM channels ch GROUP BY ch.guild_id ORDER BY messages DESC LIMIT 15`)));

app.get("/admin/channels", async (c) => {
  const g = c.req.query("guild");
  if (g !== undefined && !isId(g)) return bad(c);
  return c.json(await q(`SELECT ch.channel_id, ch.guild_id, ch.created_at, ch.last_sync_at, ch.backfill_done,
    (SELECT COUNT(*) FROM messages m WHERE m.channel_id = ch.channel_id) AS messages,
    (SELECT COUNT(*) FROM attachments a WHERE a.channel_id = ch.channel_id) AS files,
    (SELECT COALESCE(SUM(size),0) FROM attachments a WHERE a.channel_id = ch.channel_id) AS bytes,
    (SELECT COUNT(*) FROM api_keys k WHERE k.channel_id = ch.channel_id AND k.revoked_at IS NULL AND k.expires_at > UTC_TIMESTAMP()) AS active_keys
    FROM channels ch ${g ? "WHERE ch.guild_id = ?" : ""} ORDER BY messages DESC LIMIT 15`, g ? [g] : []));
});

app.get("/admin/audit", async (c) =>
  c.json(await q("SELECT at, actor, action, channel_id FROM audit_log ORDER BY id DESC LIMIT 15")));

// --- 同期状態 ---
app.get("/channels/:cid/state", async (c) => {
  const cid = c.req.param("cid");
  if (!isId(cid)) return bad(c);
  const [s] = await q("SELECT channel_id, guild_id, oldest_id, newest_id, backfill_done, last_sync_at FROM channels WHERE channel_id = ?", [cid]);
  return s ? c.json(s) : c.json({ error: "not_found" }, 404);
});

app.put("/channels/:cid/state", async (c) => {
  const cid = c.req.param("cid");
  const b = await c.req.json();
  if (!isId(cid)) return bad(c);
  const idOrNull = (v: any) => (v == null ? null : isId(String(v)) ? String(v) : undefined);
  const o = idOrNull(b.oldest_id), n = idOrNull(b.newest_id);
  if (o === undefined || n === undefined) return bad(c);
  await q(
    `UPDATE channels SET oldest_id = COALESCE(?, oldest_id), newest_id = COALESCE(?, newest_id),
     backfill_done = ?, last_sync_at = UTC_TIMESTAMP() WHERE channel_id = ?`,
    [o, n, b.backfill_done ? 1 : 0, cid],
  );
  return c.json({ ok: true });
});

// --- メッセージの取り込み(一括 upsert) ---
app.put("/channels/:cid/messages", async (c) => {
  const cid = c.req.param("cid");
  const b = await c.req.json();
  if (!isId(cid) || !Array.isArray(b.messages) || b.messages.length > 100) return bad(c);
  const [cnt] = await q("SELECT COUNT(*) AS n FROM messages WHERE channel_id = ?", [cid]);
  if (Number(cnt.n) >= config.maxMessagesPerChannel) return c.json({ error: "quota" }, 409);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    for (const m of b.messages) {
      if (![m.id, m.author_id].every((v) => isId(String(v)))) throw new Error("bad_message");
      await conn.execute(
        `INSERT INTO messages (id, channel_id, author_id, author_name, content, posted_at, edited_at, stored_at)
         VALUES (?,?,?,?,?,?,?,UTC_TIMESTAMP())
         ON DUPLICATE KEY UPDATE content = VALUES(content), edited_at = VALUES(edited_at), author_name = VALUES(author_name)`,
        [m.id, cid, m.author_id, String(m.author_name).slice(0, 100), String(m.content ?? ""), isoToSql(m.posted_at), m.edited_at ? isoToSql(m.edited_at) : null],
      );
      for (const a of m.attachments ?? []) {
        if (!isId(String(a.id))) throw new Error("bad_attachment");
        await conn.execute(
          "INSERT IGNORE INTO attachments (id, message_id, channel_id, orig_name) VALUES (?,?,?,?)",
          [a.id, m.id, cid, String(a.filename ?? "").slice(0, 255)],
        );
      }
    }
    await conn.commit();
  } catch {
    await conn.rollback();
    return bad(c);
  } finally {
    conn.release();
  }
  return c.json({ ok: true });
});

// 直近範囲の突き合わせ: [from, to] の範囲で ids に無いメッセージを削除
app.post("/channels/:cid/reconcile", async (c) => {
  const cid = c.req.param("cid");
  const b = await c.req.json();
  if (!isId(cid) || !isId(String(b.from_id)) || !isId(String(b.to_id)) || !Array.isArray(b.ids) || !b.ids.every((i: any) => isId(String(i)))) return bad(c);
  const keep = new Set<string>(b.ids.map(String));
  const rows = await q<{ id: string }>("SELECT id FROM messages WHERE channel_id = ? AND id >= ? AND id <= ?", [cid, b.from_id, b.to_id]);
  let removed = 0;
  for (const r of rows) {
    if (keep.has(r.id)) continue;
    await removeMessageFiles(cid, r.id);
    await q("DELETE FROM messages WHERE id = ? AND channel_id = ?", [r.id, cid]);
    removed++;
  }
  return c.json({ removed });
});

// --- 画像 ---
app.get("/channels/:cid/pending-attachments", async (c) => {
  const cid = c.req.param("cid");
  if (!isId(cid)) return bad(c);
  return c.json(await q("SELECT id, message_id FROM attachments WHERE channel_id = ? AND stored_at IS NULL LIMIT 50", [cid]));
});

app.put("/channels/:cid/messages/:mid/attachments/:aid", async (c) => {
  const { cid, mid, aid } = c.req.param();
  if (![cid, mid, aid].every(isId) || !c.req.raw.body) return bad(c);
  const [row] = await q("SELECT id FROM attachments WHERE id = ? AND message_id = ? AND channel_id = ?", [aid, mid, cid]);
  if (!row) return c.json({ error: "not_found" }, 404);
  const [used] = await q("SELECT COALESCE(SUM(size),0) AS n FROM attachments WHERE channel_id = ?", [cid]);
  if (Number(used.n) >= config.maxBytesPerChannel) return c.json({ error: "quota" }, 413);
  try {
    const r = await saveStream(c.req.raw.body, cid, mid, aid);
    await q("UPDATE attachments SET ext = ?, size = ?, sha256 = ?, stored_at = UTC_TIMESTAMP() WHERE id = ?", [r.ext, r.size, r.sha256, aid]);
    return c.json({ ok: true, ...r });
  } catch (e: any) {
    const code = e.message === "too_large" ? 413 : e.message === "bad_type" ? 415 : 500;
    return c.json({ error: e.message === "too_large" || e.message === "bad_type" ? e.message : "store_failed" }, code);
  }
});

app.get("/channels/:cid/attachments/:aid", async (c) => {
  const { cid, aid } = c.req.param();
  if (![cid, aid].every(isId)) return bad(c);
  const [a] = await q("SELECT message_id, ext FROM attachments WHERE id = ? AND channel_id = ? AND stored_at IS NOT NULL", [aid, cid]);
  if (!a?.ext) return c.json({ error: "not_found" }, 404);
  const p = pathFor(cid, String(a.message_id), aid, a.ext);
  if (!(await exists(p))) return c.json({ error: "not_found" }, 404);
  return new Response(Bun.file(p), {
    headers: { "content-type": MIME[a.ext], "x-content-type-options": "nosniff", "cache-control": "private, max-age=3600", "content-disposition": `inline; filename="${aid}.${a.ext}"` },
  });
});

// --- 取得 ---
app.get("/channels/:cid/messages", async (c) => {
  const cid = c.req.param("cid");
  if (!isId(cid)) return bad(c);
  const u = c.req.query();
  const where = ["m.channel_id = ?"];
  const args: any[] = [cid];
  if (u.since) { if (!isId(u.since)) return bad(c); where.push("m.id > ?"); args.push(u.since); }
  if (u.until) { if (!isId(u.until)) return bad(c); where.push("m.id < ?"); args.push(u.until); }
  if (u.from) { const d = new Date(u.from); if (isNaN(+d)) return bad(c); where.push("m.posted_at >= ?"); args.push(isoToSql(u.from)); }
  if (u.to) { const d = new Date(u.to); if (isNaN(+d)) return bad(c); where.push("m.posted_at <= ?"); args.push(isoToSql(u.to)); }
  if (u.author) { if (!isId(u.author)) return bad(c); where.push("m.author_id = ?"); args.push(u.author); }
  if (u.has === "image") where.push("EXISTS (SELECT 1 FROM attachments a WHERE a.message_id = m.id)");
  const limit = Math.min(Math.max(Number(u.limit ?? 100) || 100, 1), 500);
  const order = u.order === "desc" ? "DESC" : "ASC";
  const msgs = await q(
    `SELECT m.id, m.author_id, m.author_name, m.content, m.posted_at, m.edited_at FROM messages m
     WHERE ${where.join(" AND ")} ORDER BY m.id ${order} LIMIT ${limit}`, args);
  if (msgs.length) {
    const atts = await q(
      `SELECT id, message_id, ext, size, orig_name, stored_at IS NOT NULL AS is_stored FROM attachments WHERE message_id IN (${msgs.map(() => "?").join(",")})`,
      msgs.map((m: any) => m.id));
    for (const m of msgs as any[]) m.attachments = atts.filter((a: any) => a.message_id === m.id).map(({ message_id, ...r }: any) => r);
  }
  return c.json({ messages: msgs });
});

app.get("/channels/:cid/messages/:mid", async (c) => {
  const { cid, mid } = c.req.param();
  if (![cid, mid].every(isId)) return bad(c);
  const [m] = await q("SELECT id, author_id, author_name, content, posted_at, edited_at FROM messages WHERE id = ? AND channel_id = ?", [mid, cid]);
  if (!m) return c.json({ error: "not_found" }, 404);
  m.attachments = await q("SELECT id, ext, size, orig_name, stored_at IS NOT NULL AS is_stored FROM attachments WHERE message_id = ?", [mid]);
  return c.json(m);
});

// 期限切れ削除(Workers の cron からも叩ける)
app.post("/jobs/purge", async (c) => c.json(await purgeExpired()));

app.onError((e, c) => {
  console.error("error", e.message);
  return c.json({ error: "internal" }, 500);
});

// 毎日 1 回の期限切れ削除
setInterval(() => purgeExpired().catch((e) => console.error("purge", e.message)), 24 * 3600 * 1000);

export default { port: config.port, hostname: config.host, fetch: app.fetch, maxRequestBodySize: config.maxImageBytes + 1024 };
