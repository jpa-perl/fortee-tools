# fortee-reception

fortee 連携チェックインシステムである。fortee が発行するチケット QR を読み取り、カンファレンスごとに設定した受付ルールでチェックインを判定して記録し、その結果を fortee に一括で反映する。受付は会場のネットワークに依存せず、スタッフのスマートフォンだけで続けられる。

要件は [PRD](docs/prd.md) が、設計は [Design Doc](docs/design-doc.md) が定める。文書の一覧と優先順位は [docs/README.md](docs/README.md) にある。

## 構成

| 要素 | 場所 | 実行環境 | 役割 |
| --- | --- | --- | --- |
| 受付アプリ | `src/app/`、`src/sw/` | iOS Safari と Android Chrome の PWA（Preact） | 読み取り、判定、記録、検索、履歴、取り消し、受付の切り替え、同期。端末内のデータだけで動く |
| サーバ | `src/worker/` | Cloudflare Workers（Hono）、D1、KV | Discord ログイン、記録の収集と配布、設定とスナップショットの配布 |
| 管理 CLI | `src/cli/` | 管理者の端末の Node.js | 設定検証、取り込み、公開、書き出し、テンプレートのプレビュー、マイグレーション、デプロイ |
| 共通の規則 | `src/core/` | 上のすべて | スキーマ、判定、受付の選択、記録の集約、検索、テンプレートの描画 |
| 設定ファイル | `config/<環境名>.toml` | — | カンファレンス、イベント、受付、検索と表示の列、参考情報テンプレート |

本システムは fortee と通信しない。fortee からダウンロードした ZIP を管理者が取り込み、書き出した一括チェックイン CSV を管理者が fortee にアップロードする。

## 現在の状態

同期プロトコルと配布物の形式の版は 0（v0）である。YAPC::Tokyo 2026 は本システムの初回の利用で、v0 のまま受付に使う。カンファレンスごとに別のアプリケーションとしてデプロイし直す（Worker、D1、KV、オリジンが分かれる）。その環境は、カンファレンスの終了後、保持期間が過ぎたら削除し、次のカンファレンスには使い回さない。したがって、カンファレンスをまたぐ互換性は保たない。

確かめてあるのは、ローカルでの型検査、lint、単体テスト、画面のテスト（Playwright の Chromium と WebKit）までである。次のことは確かめていない。

- 実機での動作（カメラの読み取り、音、振動、画面のスリープ、ホーム画面に追加した Web アプリ、Android の戻る操作）
- カンファレンスの環境（リモートの D1 と KV、デプロイ、Discord の実際のログイン）
- 本物の fortee の ZIP の取り込み。テストは、[fortee の仕様調査](docs/research/fortee/README.md)の記述から合成した ZIP を使う

## 必要なもの

- Node.js 26.13.0（`.node-version`）と、同梱の npm
- ローカルでログインして動かすには、Discord のアプリケーションと、受付スタッフのロールを持つギルド
- カンファレンスの環境を作ってデプロイするには、Cloudflare のアカウントと API トークン

詳しくは開発・環境構築手順書の 2 章にある。

## 導入

```bash
npm ci
```

```bash
npx playwright install webkit chromium
```

## ローカルでの起動

ローカルの開発は、どのカンファレンスの環境とも接続しない。D1 と KV は、`.wrangler/state` 以下の模擬環境を使う。

1. `.dev.vars.example` を `.dev.vars` に写し、Discord の値とセッションの秘密を書く（手順書 4.1）。`.dev.vars` はコミットしない
2. ローカルの D1 にマイグレーションを適用する

   ```bash
   npm run cli -- migrate --env local
   ```

3. 合成の ZIP を作り、取り込んで公開する。ZIP は `.work/local/synthetic-zips/` にできる

   ```bash
   node test/cli/make-synthetic-zips.ts
   ```

   ```bash
   npm run cli -- import --env local --event main --zip .work/local/synthetic-zips/main.zip
   ```

   ```bash
   npm run cli -- import --env local --event eve --zip .work/local/synthetic-zips/eve.zip
   ```

   ```bash
   npm run cli -- import --env local --event party --zip .work/local/synthetic-zips/party.zip
   ```

   ```bash
   npm run cli -- publish --env local
   ```

4. 開発サーバを起動し、`http://localhost:5173` をデスクトップの Chrome で開く

   ```bash
   npm run dev
   ```

スマートフォンでの確認は、ローカルではなくカンファレンスの環境で行う。カメラは安全なコンテキストでしか使えず、LAN の IP アドレスへの `http://` の接続はそれに当たらないためである。

## テストと検査

```bash
npm run typecheck
```

```bash
npm run lint
```

```bash
npm test
```

```bash
npm run test:e2e
```

`npm test` は、core、app、worker、cli の単体テストと、lint の規則が違反を検出することの検査を動かす。`npm run test:e2e` は画面のテストで、サーバとデータを自分で用意する。開発用の `.wrangler/state` と `.work/` には触れない。2 つの端末から同時に走らせると、ポート（4173、4174）とテスト用のデータの作り直しがぶつかる。

## 管理 CLI

どのコマンドも `--env <環境名>` が必須で、既定値はない。環境名から、wrangler の env、作業ディレクトリ（`.work/<環境名>/`）、既定の設定ファイル（`config/<環境名>.toml`）が決まる。`--env local` は、ローカルの模擬環境を読み書きする。

```bash
npm run cli -- <コマンド> --env <環境名>
```

| コマンド | 主な引数 | すること |
| --- | --- | --- |
| `migrate` | — | D1 にマイグレーションを適用し、環境の印を書く |
| `validate` | — | 設定ファイルを検証し、誤りをすべて列挙する |
| `import` | `--event <key か id> --zip <ZIP>` | fortee のダウンロード ZIP を、イベント単位でスナップショットに変換する |
| `publish` | — | 設定と全イベントのスナップショットを公開する |
| `preview` | `--event <key か id> --ticket <番号>` | 参考情報テンプレートを、指定した参加者で描画し、結果の HTML を出す |
| `export` | `--out <まだないディレクトリ> [--chunk <行数>]` | 記録を集約し、一括チェックイン CSV と確認用の一覧を書き出す |
| `restore-records` | `--from <records.json>` | DB を以前の時点に戻した後の復旧で、書き出しの `records.json` から、D1 にない記録を戻す |
| `bump-generation` | — | DB を以前の時点に戻した後の復旧で、DB の世代を変え、端末に記録を送り直させる |
| `deploy` | — | ビルドして、その環境にデプロイする |

受付の準備から fortee への反映までの運用の流れは PRD の 9 章に、カンファレンスの環境の作成、秘密の設定、最初のデプロイは[本番環境構築手順書](docs/production-setup.md)に、運用の開始、その後のデプロイ、保持期間の後の削除は手順書の 6 章以降にある。

## 文書

| 文書 | 内容 |
| --- | --- |
| [docs/prd.md](docs/prd.md) | 要件（機能要件、非機能要件、データ要件、運用手順、受け入れ基準） |
| [docs/screen-design.md](docs/screen-design.md) | 受付アプリの画面、要素、状態、文言 |
| [docs/design-doc.md](docs/design-doc.md) | 構成、層のあいだで共有する契約、各層の内部構成、版と互換性、テストの方針 |
| [docs/dev-setup.md](docs/dev-setup.md) | 開発、運用の開始、デプロイ、削除のコマンドの手順 |
| [docs/production-setup.md](docs/production-setup.md) | カンファレンスの環境（本番環境）を作る手順 |
| [docs/research/](docs/research/) | fortee の仕様、バックエンドとフロントエンドの選定、端末の挙動の調査 |
