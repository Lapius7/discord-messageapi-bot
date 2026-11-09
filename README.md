# discord-messageapi-bot

Discord のチャンネルに投稿された本文と画像を保存し、チャンネル専用のキーで取り出せるようにする Bot と API です。取り出した内容は、自分のコンピューターで動かす Claude Code などの AI で、ノートにまとめたり分析したりできます。

## Bot を追加する

[このリンクから Bot をサーバーに追加します](https://discord.com/oauth2/authorize?client_id=1569259751055949844&permissions=66560&scope=bot%20applications.commands)

Bot に求める権限は次の2つだけです。

- チャンネルを見る
- メッセージ履歴を読む

投稿の本文を読むため、Discord の Message Content Intent を使います。

## 使い方

1. 保存したいチャンネルで `/connect` を実行します。実行には、そのチャンネルの「チャンネルの管理」権限が必要です。
2. 実行した人にだけ見えるメッセージで、キーと、AI に貼り付ける文が表示されます。キーは再表示できません。
3. 貼り付ける文の「やりたいこと」を書き換えて、Claude Code などに渡します。AI は、`/llms.md` を読んで API を使います。

`/connect` より前の投稿も、少しずつ取り込まれます。投稿が多いチャンネルでは、全件がそろうまでに時間がかかります。

### コマンド

| コマンド | 内容 |
|---|---|
| `/connect` | キーを発行し、取り込みを始める。再実行すると古いキーは失効する |
| `/keys` | このチャンネルのキーの一覧 |
| `/revoke` | キーを今すぐ失効する |
| `/disconnect` | キーを失効し、このチャンネルの本文と画像をすべて削除する |

## API

認証は `Authorization: Bearer <キー>` です。キーに対応するチャンネルのデータだけを返します。

| パス | 内容 |
|---|---|
| `GET /v1/messages` | 本文の一覧(期間、投稿者、画像つきなどで絞り込める) |
| `GET /v1/messages/{id}` | 1件の本文 |
| `GET /v1/attachments/{id}` | 画像 |
| `GET /v1/export` | 期間を指定して Markdown か JSON でまとめて取得 |

パラメータと応答の形は、AI 向けの説明 `https://discord-messageapi-bot.wks.lapius7.com/llms.md`(ソースは `src/llms.ts`)に書いています。

## 保存と安全

- 本文と画像は、保存した時点から3か月で自動的に削除します。
- キーは30日で期限切れになります。キーを発行した人がチャンネルを見られなくなると、キーは使えなくなります。
- キーそのものは保存せず、ハッシュだけを保存します。
- 保存量には上限があります。1チャンネルあたり本文20万件か画像の合計5GB、1サーバーあたり20チャンネルです。
- 取得した本文は、他人が書いたデータです。AI に渡すときは、中の指示に従わせないでください。

詳しくは [利用規約](docs/TERMS.md) と [プライバシーポリシー](docs/PRIVACY.md) を見てください。

## 構成

```
Discord ─> Cloudflare Workers ─> サーバー(本文と画像を保存)
AI(利用者の PC) ──(キー)──> Cloudflare Workers
```

| ディレクトリ | 内容 |
|---|---|
| `src/` | Cloudflare Workers(Bot の応答、公開 API、Discord からの取り込み) |
| `internal/` | サーバー側の処理(本文と画像の保存、期限切れの削除) |
| `cli/` | `dcfetch`(取得して手元に保存する CLI)と、AI 用の skill `dcm-channel` |
| `deploy/` | サーバーのセットアップとデプロイのスクリプト |
| `docs/` | 利用規約とプライバシーポリシー |

## 開発

```
pnpm install
bun test test
pnpm exec wrangler deploy    # Workers
DCM_DEPLOY_HOST=<ssh のホスト名> bash deploy/deploy.sh    # サーバー側
```

Workers には `DISCORD_PUBLIC_KEY`、`DISCORD_BOT_TOKEN`、`DISCORD_APP_ID`、`INTERNAL_SECRET` を `wrangler secret put` で登録します。サーバー側の設定は `deploy/setup.sh` が行います。シークレットはリポジトリに入れません。

## ライセンス

全権利を留保します([LICENSE](LICENSE))。コードの利用、複製、改変、再配布はできません。Bot と API のサービスとしての利用は、[利用規約](docs/TERMS.md)の範囲で自由です。
