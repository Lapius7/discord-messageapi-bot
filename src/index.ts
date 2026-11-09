import { Hono } from "hono";
import { api } from "./api";
import { verifyDiscord } from "./crypto";
import { handleInteraction } from "./interactions";
import { internal } from "./internal";
import { llmsMd } from "./llms";
import { issuerCanRead } from "./perms";
import { Budget, reconcile, retryPending, syncChannel } from "./sync";
import type { Env } from "./types";

const app = new Hono<{ Bindings: Env }>();


const REPO = "https://github.com/Lapius7/discord-messageapi-bot";
app.get("/", (c) => c.redirect(REPO, 302));

const errorPage = (status: number, title: string, text: string) => new Response(
  `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${status} ${title}</title>
<style>:root{color-scheme:light dark}body{margin:0;min-height:100svh;display:grid;place-items:center;font:16px/1.7 system-ui,sans-serif;background:Canvas;color:CanvasText}main{padding:24px;text-align:center}h1{margin:0;font-size:64px;font-weight:600;letter-spacing:-.02em}p{margin:8px 0 24px;opacity:.7}a{color:inherit}</style></head>
<body><main><h1>${status}</h1><p>${text}</p><a href="/">トップへ戻る</a></main></body></html>`,
  { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });

app.notFound((c) => new URL(c.req.url).pathname.startsWith("/v1/")
  ? c.json({ error: "not_found" }, 404)
  : errorPage(404, "ページが見つかりません", "お探しのページは存在しません。"));
app.onError((e, c) => { console.error(e); return errorPage(500, "エラーが発生しました", "時間をおいてもう一度お試しください。"); });

const llms = (c: any) => c.text(llmsMd(new URL(c.req.url).origin), 200, { "content-type": "text/markdown; charset=utf-8", "cache-control": "public, max-age=300" });
app.get("/llms.md", llms);
app.get("/llms.txt", llms);

app.post("/interactions", async (c) => {
  const raw = await c.req.text();
  const ok = await verifyDiscord(c.env.DISCORD_PUBLIC_KEY, c.req.header("x-signature-ed25519") ?? null, c.req.header("x-signature-timestamp") ?? null, raw);
  if (!ok) return c.text("invalid request signature", 401);
  const base = new URL(c.req.url).origin;
  return c.json(await handleInteraction(c.env, c.executionCtx, JSON.parse(raw), base));
});

app.route("/", api);
app.onError((_e, c) => c.json({ error: "internal" }, 500));

export default {
  fetch: app.fetch,
  // 1 時間ごと: 全チャンネルを順に同期・突き合わせ・期限切れ削除
  async scheduled(_e: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil((async () => {
      const api = internal(env);
      const r = await api.json("GET", "/channels");
      const chans = r.ok ? await r.json<{ channel_id: string; guild_id: string; created_by: string }[]>() : [];
      const shared = new Budget(Number(env.CRON_SUBREQUESTS) || 45);
      for (const ch of chans) {
        if ((await issuerCanRead(env, ch.guild_id, ch.channel_id, ch.created_by)) === false) {
          await api.json("POST", `/channels/${ch.channel_id}/revoke`, {}, "system:issuer-lost-access");
          continue;
        }
        if (shared.left < 6) break;
        const b = shared;
        await syncChannel(env, ch.channel_id, b).catch(() => {});
        await retryPending(env, ch.channel_id, b).catch(() => {});
        await reconcile(env, ch.channel_id, b).catch(() => {});
      }
      await api.json("POST", "/jobs/purge");
    })());
  },
};
