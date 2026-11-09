import { DiscordError, dget, fetchMessages, isStorableImage, snowflakeFromMs, toInternal, type DMessage } from "./discord";
import { internal } from "./internal";
import type { Env } from "./types";

/** 1 回の実行で使える外部呼び出しの予算(Workers のサブリクエスト上限に合わせる) */
export class Budget {
  constructor(public left: number) {}
  take(n = 1) { if (this.left < n) return false; this.left -= n; return true; }
}

const big = (a: string, b: string) => (BigInt(a) > BigInt(b) ? a : b);
const small = (a: string, b: string) => (BigInt(a) < BigInt(b) ? a : b);

/** 新しいメッセージ → 過去分 → 未保存の画像 の順に取り込む。 */
export async function syncChannel(env: Env, channelId: string, budget: Budget) {
  const api = internal(env);
  const st = await api.json("GET", `/channels/${channelId}/state`).then((r) => (r.ok ? r.json<any>() : null));
  if (!st) return;
  let { oldest_id: oldest, newest_id: newest } = st as { oldest_id: string | null; newest_id: string | null };
  let done = !!Number(st.backfill_done);

  let full = false;
  try {
    const ingest = async (msgs: DMessage[]) => {
      if (!msgs.length || !budget.take()) return;
      const pr = await api.json("PUT", `/channels/${channelId}/messages`, { messages: msgs.map(toInternal) });
      if (pr.status === 409) { full = true; done = true; return; } // チャンネルあたりの保存上限
      if (!pr.ok) throw new Error("ingest_failed");
      for (const m of msgs) await uploadImages(env, channelId, m, budget);
      for (const m of msgs) {
        newest = newest ? big(newest, m.id) : m.id;
        oldest = oldest ? small(oldest, m.id) : m.id;
      }
    };

    // 1) 新着
    if (!newest) {
      if (budget.take()) await ingest(await fetchMessages(env, channelId, {}));
    } else {
      while (!full && budget.left > 4) {
        if (!budget.take()) break;
        const page = await fetchMessages(env, channelId, { after: newest! });
        if (!page.length) break;
        await ingest(page);
        if (full || page.length < 100) break;
      }
    }
    // 2) 過去分(/connect より前の投稿)
    while (!full && !done && oldest && budget.left > 4) {
      if (!budget.take()) break;
      const page = await fetchMessages(env, channelId, { before: oldest });
      if (!page.length) { done = true; break; }
      await ingest(page);
      if (page.length < 100) done = true;
    }
    await api.json("PUT", `/channels/${channelId}/state`, { oldest_id: oldest, newest_id: newest, backfill_done: done });
  } catch (e) {
    // Bot がチャンネルを見られなくなったら、全キーを失効
    if (e instanceof DiscordError && (e.status === 403 || e.status === 404)) {
      await api.json("POST", `/channels/${channelId}/revoke`, {}, "system:lost-access");
    }
  }
}

/** 画像をダウンロードして サーバーへストリームで送る。期限切れ URL を避けるため取り込み直後に行う。 */
async function uploadImages(env: Env, channelId: string, m: DMessage, budget: Budget) {
  const api = internal(env);
  for (const a of m.attachments.filter(isStorableImage)) {
    if (!budget.take(2)) return;
    try {
      const src = await fetch(a.url);
      if (!src.ok || !src.body) continue;
      await api.call(`/channels/${channelId}/messages/${m.id}/attachments/${a.id}`, { method: "PUT", body: src.body });
    } catch { /* 未保存のまま残り、次回 retryPending が拾う */ }
  }
}

/** 未保存の画像を、メッセージを取り直して(新しい URL で)保存する。 */
export async function retryPending(env: Env, channelId: string, budget: Budget) {
  const api = internal(env);
  const pend = await api.json("GET", `/channels/${channelId}/pending-attachments`).then((r) => (r.ok ? r.json<{ id: string; message_id: string }[]>() : []));
  const byMsg = new Map<string, string[]>();
  for (const p of pend) byMsg.set(p.message_id, [...(byMsg.get(p.message_id) ?? []), p.id]);
  for (const [mid] of byMsg) {
    if (!budget.take()) return;
    try { await uploadImages(env, channelId, await dget<DMessage>(env, `/channels/${channelId}/messages/${mid}`), budget); } catch { /* 削除済みなど */ }
  }
}

/** 直近 N 日を取り直して、編集の反映と削除の突き合わせをする(cron 用)。 */
export async function reconcile(env: Env, channelId: string, budget: Budget) {
  const api = internal(env);
  const days = Number(env.RECONCILE_DAYS) || 7;
  const from = snowflakeFromMs(Date.now() - days * 86400_000);
  const ids: string[] = [];
  let after = from;
  while (budget.left > 3) {
    if (!budget.take()) return;
    const page = await fetchMessages(env, channelId, { after });
    if (!page.length) break;
    if (!budget.take()) return;
    await api.json("PUT", `/channels/${channelId}/messages`, { messages: page.map(toInternal) });
    for (const m of page) { ids.push(m.id); after = big(after, m.id); }
    if (page.length < 100) break;
  }
  // 範囲をすべて読み切れたときだけ削除する(途中で止めたときは消さない)
  if (budget.left > 0 && budget.take()) {
    await api.json("POST", `/channels/${channelId}/reconcile`, { from_id: from, to_id: after === from ? from : after, ids });
  }
}
