import { Hono } from "hono";
import { sha256Hex } from "./crypto";
import { internal } from "./internal";
import { issuerCanRead } from "./perms";
import { Budget, retryPending, syncChannel } from "./sync";
import type { Env } from "./types";

type Vars = { Variables: { channelId: string; keyHash: string } };
export const api = new Hono<{ Bindings: Env } & Vars>();

const NO_STORE = { "cache-control": "no-store", "x-content-type-options": "nosniff" };

// 認証とレート制限。失敗理由は区別せず 401 にする(キーの存在を推測させない)。
api.use("/v1/*", async (c, next) => {
  const ip = c.req.header("cf-connecting-ip") ?? "unknown";
  if (!(await c.env.IP_LIMITER.limit({ key: ip })).success) return c.json({ error: "rate_limited" }, 429, { "retry-after": "30" });
  const m = /^Bearer (dcm_[A-Za-z0-9_-]{43})$/.exec(c.req.header("authorization") ?? "");
  if (!m) return c.json({ error: "unauthorized" }, 401, NO_STORE);
  const hash = await sha256Hex(m[1]);
  if (!(await c.env.KEY_LIMITER.limit({ key: hash })).success) return c.json({ error: "rate_limited" }, 429, { "retry-after": "30" });
  const r = await internal(c.env).call(`/keys/lookup/${hash}`);
  if (!r.ok) return c.json({ error: "unauthorized" }, 401, NO_STORE);
  const k = await r.json<{ channel_id: string; guild_id: string; created_by: string }>();
  // 発行者がチャンネルを読めなくなっていたら、キーを失効して拒否する
  if ((await issuerCanRead(c.env, k.guild_id, k.channel_id, k.created_by)) === false) {
    await internal(c.env).json("POST", `/channels/${k.channel_id}/revoke`, {}, "system:issuer-lost-access");
    return c.json({ error: "unauthorized" }, 401, NO_STORE);
  }
  c.set("channelId", k.channel_id);
  c.set("keyHash", hash);
  await next();
  for (const [h, v] of Object.entries(NO_STORE)) c.res.headers.set(h, v);
});

const ALLOWED = ["since", "until", "from", "to", "author", "has", "limit", "order"];
const pass = (url: URL) => {
  const p = new URLSearchParams();
  for (const k of ALLOWED) { const v = url.searchParams.get(k); if (v) p.set(k, v); }
  return p.toString();
};

/** 呼び出し時に新着だけ軽く同期(予算は小さく)。失敗しても取得自体は続ける。 */
async function lightSync(c: any, channelId: string) {
  const b = new Budget(12);
  try { await syncChannel(c.env, channelId, b); await retryPending(c.env, channelId, b); } catch { /* 保存済みの分を返す */ }
}

api.get("/v1/messages", async (c) => {
  const cid = c.get("channelId");
  await lightSync(c, cid);
  const r = await internal(c.env).call(`/channels/${cid}/messages?${pass(new URL(c.req.url))}`);
  return new Response(r.body, { status: r.status, headers: { "content-type": "application/json", ...NO_STORE } });
});

api.get("/v1/messages/:id", async (c) => {
  const id = c.req.param("id");
  if (!/^\d{1,20}$/.test(id)) return c.json({ error: "bad_request" }, 400);
  const r = await internal(c.env).call(`/channels/${c.get("channelId")}/messages/${id}`);
  return new Response(r.body, { status: r.status, headers: { "content-type": "application/json", ...NO_STORE } });
});

api.get("/v1/attachments/:id", async (c) => {
  const id = c.req.param("id");
  if (!/^\d{1,20}$/.test(id)) return c.json({ error: "bad_request" }, 400);
  const r = await internal(c.env).call(`/channels/${c.get("channelId")}/attachments/${id}`);
  if (!r.ok) return c.json({ error: "not_found" }, 404);
  const h = new Headers({ "content-type": r.headers.get("content-type") ?? "application/octet-stream", "content-disposition": r.headers.get("content-disposition") ?? "inline", ...NO_STORE });
  return new Response(r.body, { headers: h });
});

/** 講義ノート向けの一括出力。md は画像を相対リンク(attachments/<id>.<ext>)にする。 */
api.get("/v1/export", async (c) => {
  const cid = c.get("channelId");
  const fmt = c.req.query("format") === "json" ? "json" : "md";
  await lightSync(c, cid);
  const all: any[] = [];
  const q = new URL(c.req.url);
  let since = q.searchParams.get("since") ?? "";
  for (let i = 0; i < 10; i++) {
    const p = new URLSearchParams(pass(q)); p.set("limit", "500"); p.set("order", "asc");
    if (since) p.set("since", since);
    const r = await internal(c.env).call(`/channels/${cid}/messages?${p}`);
    if (!r.ok) return c.json({ error: "upstream" }, 502);
    const { messages } = await r.json<{ messages: any[] }>();
    all.push(...messages);
    if (messages.length < 500) break;
    since = messages[messages.length - 1].id;
  }
  if (fmt === "json") return c.json({ messages: all }, 200, NO_STORE);
  const md = all.map((m) => {
    const imgs = (m.attachments ?? []).filter((a: any) => a.ext).map((a: any) => `![${a.orig_name}](attachments/${a.id}.${a.ext})`).join("\n");
    return `## ${m.posted_at} ${m.author_name} (id: ${m.id})\n\n${m.content}${imgs ? "\n\n" + imgs : ""}`;
  }).join("\n\n---\n\n");
  return new Response(md, { headers: { "content-type": "text/markdown; charset=utf-8", ...NO_STORE } });
});
