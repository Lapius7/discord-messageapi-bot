#!/usr/bin/env node
// dcfetch: Discord チャンネルの本文と画像を、キーで取得して手元に保存する。
// 使い方: DCM_KEY=dcm_... dcfetch export [--out DIR] [--from ISO] [--to ISO] [--since ID] [--author ID] [--images-only] [--no-images]
// 環境変数: DCM_KEY(必須)、DCM_BASE(既定: https://discord-messageapi-bot.wks.lapius7.com)
// キーは引数で受け取らない(シェル履歴とプロセス一覧に残るため)。Node 18 以上。
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const BASE = (process.env.DCM_BASE ?? "https://discord-messageapi-bot.wks.lapius7.com").replace(/\/$/, "");
const KEY = process.env.DCM_KEY ?? "";
const EXT = new Set(["png", "jpg", "gif", "webp"]);
const isId = (s) => /^\d{1,20}$/.test(String(s));

const die = (m) => { console.error(`dcfetch: ${m}`); process.exit(1); };
const help = () => console.log(`使い方: DCM_KEY=dcm_... dcfetch export [--out DIR] [--from ISO] [--to ISO] [--since ID]
  --out    保存先(既定: ./discord-export)。attachments/ と messages.json と lecture.md を作る
  --from   この日時以降の投稿だけ取る(ISO 8601)
  --to     この日時以前の投稿だけ取る
  --since  このメッセージ ID より新しい投稿だけ取る(前回の続きから取るとき)
  --author 投稿者のユーザー ID で絞る
  --images-only  画像つきの投稿だけ取る
  --no-images    画像をダウンロードしない(本文だけ取る)
出力: messages.json(全項目)、transcript.md(日時・投稿者・本文・画像リンク)、attachments/`);

const args = process.argv.slice(2);
if (!args.length || args[0] === "-h" || args[0] === "--help") { help(); process.exit(0); }
if (args[0] !== "export") die("サブコマンドは export だけです");
const opt = {};
for (let i = 1; i < args.length; i++) {
  const a = args[i];
  if (a === "--images-only" || a === "--no-images") { opt[a.slice(2)] = true; continue; }
  if (!/^--(out|from|to|since|author)$/.test(a) || args[i + 1] === undefined) die(`引数が不正です: ${a}`);
  opt[a.slice(2)] = args[++i];
}
if (!/^dcm_[A-Za-z0-9_-]{43}$/.test(KEY)) die("環境変数 DCM_KEY に、/connect で発行されたキーを設定してください");
if (!/^https:\/\//.test(BASE) && !/^http:\/\/(localhost|127\.0\.0\.1)/.test(BASE)) die("DCM_BASE は https のみ使えます");
if (opt.since && !isId(opt.since)) die("--since はメッセージ ID(数字)で指定してください");
if (opt.author && !isId(opt.author)) die("--author はユーザー ID(数字)で指定してください");

const get = async (path) => {
  const r = await fetch(BASE + path, { headers: { authorization: `Bearer ${KEY}` } });
  if (r.status === 401) die("キーが無効か、期限切れです。/connect で再発行してください");
  if (r.status === 429) die("レート制限に達しました。しばらく待ってください");
  if (!r.ok) die(`API エラー ${r.status}`);
  return r;
};

const out = resolve(opt.out ?? "./discord-export");
await mkdir(join(out, "attachments"), { recursive: true });

// 本文: 100 件ずつ、古い順に取り切る
const all = [];
let since = opt.since ?? "";
for (;;) {
  const p = new URLSearchParams({ limit: "100", order: "asc" });
  if (since) p.set("since", since);
  if (opt.from) p.set("from", opt.from);
  if (opt.to) p.set("to", opt.to);
  if (opt.author) p.set("author", opt.author);
  if (opt["images-only"]) p.set("has", "image");
  const { messages } = await (await get(`/v1/messages?${p}`)).json();
  all.push(...messages);
  if (messages.length < 100) break;
  since = messages[messages.length - 1].id;
}

// 画像: ID と拡張子を検証してから、ID 名で保存する(サーバー由来のファイル名は使わない)
let saved = 0, missing = 0;
for (const m of opt["no-images"] ? [] : all) {
  for (const a of m.attachments ?? []) {
    if (!isId(a.id) || !EXT.has(a.ext) || a.is_stored !== "1") { missing++; continue; }
    const r = await get(`/v1/attachments/${a.id}`);
    await writeFile(join(out, "attachments", `${a.id}.${a.ext}`), Buffer.from(await r.arrayBuffer()));
    saved++;
  }
}

const md = all.map((m) => {
  const imgs = (m.attachments ?? []).filter((a) => isId(a.id) && EXT.has(a.ext) && a.is_stored === "1")
    .map((a) => `![画像](attachments/${a.id}.${a.ext})`).join("\n");
  return `## ${m.posted_at} ${m.author_name}\n\n${m.content}${imgs ? `\n\n${imgs}` : ""}`;
}).join("\n\n---\n\n");

await writeFile(join(out, "messages.json"), JSON.stringify(all, null, 2));
await writeFile(join(out, "transcript.md"), md + "\n");
console.log(`メッセージ ${all.length} 件、画像 ${saved} 枚を ${out} に保存しました${missing ? `(未保存の画像 ${missing} 枚)` : ""}`);
