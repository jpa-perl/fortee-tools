# 開発・環境構築手順書

本書は、fortee 連携チェックインシステムを開発し、カンファレンスの環境を作ってデプロイするまでの手順を定める。対象は、開発に要る道具、依存関係の導入、ローカルでの起動とテスト、カンファレンスの環境の作成、マイグレーション、秘密の設定、デプロイ、v1 への切り替え、保持期間の後の削除である。

手順の前提になる設計は [Design Doc](design-doc.md) にあり、本書は繰り返さない。環境とその構成要素の対応は Design Doc 3.6、管理 CLI のコマンドは 8.1、版と互換性は 9.5〜9.7 にある。受付の運用の手順（準備、リハーサル、直前、端末の準備、受付中、終了後）は [PRD](prd.md) 9 章にある。

本書のコマンドは、Design Doc 3.4 のリポジトリの構成と 8.1 の CLI を前提にしている。実装と、構築の最初に確かめること（Design Doc 12 章、[バックエンド](research/backend.md) 8 章、[フロントエンド](research/frontend.md) 7 章）の結果に合わせて、本書を直す。

コマンドは、リポジトリの `fortee-reception/` で実行する（Design Doc 3.4）。

2026-11-12 の時点で実装してあるのは、基盤である。各層の骨組みと依存の方向の検査、共有する契約のスキーマ、Worker のセッションの検証と配布物の配信、Service Worker とアプリの殻、CLI の `migrate` がある。Discord のログイン、同期、受付の画面と、CLI のほかのコマンド（`validate`、`import`、`preview`、`publish`、`export`、`restore-records`、`bump-generation`、`deploy`）は、まだない。まだないコマンドは、環境の照合（Design Doc 8.1）まで行ってから、実装していないことを知らせて終わる。したがって、いまの実装で実行できる手順は、3 章、4.1、4.2、4.4 である。4.2 で開く画面は、基盤の動作を確かめるための仮の画面で、ログインはできない。4.3 と 5 章以降は、残りを実装した後の手順である。

## 1. 用語

| 用語 | 意味 |
| --- | --- |
| 環境 | 1 つのカンファレンスのための Worker、D1、KV、秘密、設定ファイル、作業ディレクトリの組（Design Doc 3.6） |
| 環境名 | 環境の名前。そのカンファレンスの fortee のスラッグ（例 `yapc-tokyo-2026`）。ローカルの開発は `local` |
| v1 | 記録を引き継ぐ最初のリリースのタグ。リハーサル（PRD 9 章）から使う。v1 より前のデータは v1 への切り替えで消え、v1 以後の記録は消さない（Design Doc 3.6、9.6） |
| 環境の印 | D1 と KV に置く環境名。`migrate` が書き、CLI のコマンドが `--env` と照合する（Design Doc 3.6、8.1） |

## 2. 必要なもの

| 対象 | 用途 | 備考 |
| --- | --- | --- |
| Node.js（LTS） | ビルド、テスト、管理 CLI、wrangler | 版は `package.json` の `engines` と `.node-version` で固定する。wrangler と Vite が求める版を満たすものとして、26.13.0 を選んだ（`engines` は `^26.13.0`）。管理 CLI は、この Node.js が TypeScript をそのまま実行する（Design Doc 3.2） |
| npm | 依存関係の導入 | Node.js に同梱のもの |
| Git | ソースの取得、リリース名 | `deploy` がリリース名に `git describe` を使う（Design Doc 8.1） |
| Cloudflare のアカウントと API トークン | 環境の作成、デプロイ、管理 CLI | トークンの権限はバックエンド 4 章のとおり、操作ごとに絞る。4 章の表にない操作では、D1 と KV の作成とマイグレーションに D1 と Workers KV Storage の Edit、デプロイと秘密の設定に Workers Scripts の Edit を付ける（ほかに要る権限は、環境を作るときに確かめる）。トークンには、作る管理者のメンバーのロールが持つ権限までしか付けられないので、管理者には、これらの権限を含むロールを与えておく。Workers Platform Admin で足りる（バックエンド 4 章）。`wrangler login` は使わない。`--scopes` で OAuth のスコープを選べるが、API トークンなら、D1 と KV の読み取りだけの権限と編集の権限を、操作ごとに作り分けられる（バックエンド 4 章）。`--scopes` で同じ粒度に絞れるかは確かめていない |
| Discord のアプリケーションとギルド | ログイン | カンファレンスの環境とローカルの開発で、同じものを使う（Design Doc 3.6） |
| デスクトップの Chrome | ローカルでの確認 | Playwright のブラウザは、これとは別に入れる（3 章） |
| iPhone と Android の端末 | 実機での確認 | ローカルではなく、カンファレンスの環境で確かめる。v1 以後の環境で試したチェックインは、受付の記録として残る（Design Doc 3.6） |

## 3. 依存関係の導入

```bash
npm ci
```

```bash
npx playwright install webkit chromium
```

`npm install` ではなく `npm ci` を使い、`package-lock.json` の版をそのまま入れる。ライブラリの版を上げるときは、Design Doc 14 章とフロントエンド 8 章の表も直す。

## 4. ローカルでの開発

ローカルの開発は、どのカンファレンスの環境とも接続しない（Design Doc 3.6）。開発サーバは `wrangler.jsonc` の最上位の設定で動き、D1 と KV はローカルの模擬環境（`.wrangler/state` 以下）を使う。

### 4.1 ローカル用の秘密

1. 本番と同じ Discord のアプリケーションに、リダイレクト URI `http://localhost:5173/auth/discord/callback` を加える。ポートは Vite の開発サーバのもの
2. `.dev.vars.example` を `.dev.vars` に写し、値を書く

| 名前 | 値 |
| --- | --- |
| `DISCORD_CLIENT_ID`、`DISCORD_CLIENT_SECRET` | 本番と同じ Discord のアプリケーションの値 |
| `DISCORD_GUILD_ID`、`DISCORD_ROLE_IDS` | 本番と同じギルドと、受付スタッフのロール（カンマ区切り）。ログインする開発者も、そのロールを持つ |
| `SESSION_SECRET` | 暗号論的疑似乱数で生成した 32 バイトの値。たとえば次のコマンドで作る |

```bash
openssl rand -base64 32
```

`.dev.vars` には本番と同じクライアントシークレットが入る。開発者は手元の秘密を善良に管理することを前提とし、`.dev.vars` をコミットせず、ほかの場所に写さない（Design Doc 3.6）。

### 4.2 起動

ローカルの D1 にマイグレーションを適用してから、開発サーバを起動する。`migrate` は、ローカルの D1 と KV に環境の印（`local`）も書く。

```bash
npm run cli -- migrate --env local
```

```bash
npm run dev
```

`http://localhost:5173` を、デスクトップの Chrome で開く。Discord のログインと Cookie の扱いは、本番と同じ形で動く（Design Doc 3.5）。

### 4.3 ローカルへの取り込みと公開

ローカルの設定は `config/local.toml` に置き、Sandbox のカンファレンスのスラッグとイベント ID を書く。`conference.environment` は `local` にする。取り込む ZIP は、`test/` にある Sandbox のフィクスチャを使う。本番の ZIP は参加者の情報を含むので、リポジトリに置かない。

```bash
npm run cli -- validate --env local
```

```bash
npm run cli -- import --env local --event <イベントの key> --zip <ZIP のパス>
```

```bash
npm run cli -- publish --env local
```

### 4.4 テストと検査

```bash
npm test
```

```bash
npm run test:e2e
```

```bash
npm run typecheck
```

```bash
npm run lint
```

`npm test` は core、app、worker、cli の Vitest と、lint の規則が違反を検出することの検査（Design Doc 3.2）を、`npm run test:e2e` は Playwright の画面のテストを動かす。何を確かめるかは Design Doc 11 章にある。

## 5. カンファレンスの環境を作る

カンファレンスごとに 1 回行う。オリジンは、スタッフの端末を準備する前に決め、以後は変えない（バックエンド 2.2）。

1. 環境名（fortee のスラッグ）と、使う Cloudflare のアカウントを決める。ほかの環境と同じアカウントにするときは、Design Doc 3.6 の、上限と API トークンの範囲を分け合うことを確かめる
2. API トークンを環境変数に置く。シェルの履歴に残さないよう、値は入力して読み込む

   ```bash
   read -s CLOUDFLARE_API_TOKEN && export CLOUDFLARE_API_TOKEN
   ```

   与えたロールとトークンの権限が足りているかは、続く 3〜8 のコマンドが通ることで確かめる（バックエンド 8.1）

3. D1 と KV を作る。設定ファイルに足すかを聞かれたら断り、出力された ID を控える（バックエンド 8.2）

   ```bash
   npx wrangler d1 create checkin-<環境名> --location apac
   ```

   ```bash
   npx wrangler kv namespace create checkin-<環境名>
   ```

   D1 を作ったら、主インスタンスの位置を確かめる（バックエンド 8.1）

4. `wrangler.jsonc` の `env` に、環境名のブロックを足す。Worker の名前、`account_id`、D1 と KV の ID を書く（Design Doc 3.6 の例）
5. `config/<環境名>.toml` を作り、`conference.environment` に環境名を書く。設定の書き方は Design Doc 4.2 にある
6. D1 にマイグレーションを適用する。`migrate` は、まだ印のない D1 と KV に環境の印を書く。ほかのコマンドは、印がないと止まるので、`migrate` を最初に行う（Design Doc 8.1）

   ```bash
   npm run cli -- migrate --env <環境名>
   ```

7. デプロイする。`deploy` は、作業ツリーに未コミットの変更があると止まる（Design Doc 8.1）

   ```bash
   npm run cli -- deploy --env <環境名>
   ```

8. Worker の秘密を入れる。秘密を入れるまでは、ログインが失敗する。Discord の値は本番のアプリケーションとギルドのもので、`SESSION_SECRET` は 4.1 と同じく暗号論的疑似乱数で生成した値にする（Design Doc 3.6）

   ```bash
   npx wrangler secret put DISCORD_CLIENT_ID --env <環境名>
   ```

   `DISCORD_CLIENT_SECRET`、`DISCORD_GUILD_ID`、`DISCORD_ROLE_IDS`、`SESSION_SECRET` も、同じコマンドで入れる

9. 同じ Discord のアプリケーションに、リダイレクト URI `https://checkin-<環境名>.<アカウントのサブドメイン>.workers.dev/auth/discord/callback` を加える
10. 設定を検証し、ZIP を取り込んで公開する。取り込みの後に、取り込みが出すチケット種別とチケット番号の接頭辞が、指定したイベントのものであることを確かめる（PRD 9 章）

    ```bash
    npm run cli -- validate --env <環境名>
    ```

    ```bash
    npm run cli -- import --env <環境名> --event <イベントの key> --zip <ZIP のパス>
    ```

    ```bash
    npm run cli -- publish --env <環境名>
    ```

11. スマートフォンでオリジンを開き、ログインからスナップショットの取得までが通ることを確かめる

## 6. v1 より前の開発

最初のカンファレンスの環境は v1 より前に作り、開発中の確認に使う。この間は、コードの変更を `deploy` でそのまま配ってよく、互換性を壊す変更も配ってよい（Design Doc 9.6）。取り込む ZIP は、Sandbox のものでも本番のものでもよい。この間のデータは、v1 への切り替え（7 章）で消えるので、途中で消す必要はない。

スキーマを作り直すときは、D1 を作り直す。D1 を消して 5 章の 3 で作り直し、`wrangler.jsonc` の ID を書き換え（5 章の 4）、`migrate` をやり直す（5 章の 6）。KV の環境の印は残り、作り直した D1 の印を `migrate` が書く。

## 7. v1 への切り替えとリハーサル

リハーサル（PRD 9 章）の記録は受付に引き継ぐので、リハーサルは v1 以後のリリースで行う（Design Doc 3.6）。リハーサルの前に、次の順に行う。v1 より後に作った環境（2 つ目以後のカンファレンス）では、5 章で環境を作った後に 5〜7 を行う。

1. マイグレーションを 1 つの初期のマイグレーションにまとめる（Design Doc 9.6）。ファイルには、v1 より前に使ったどのファイル名とも重ならない名前を付け（たとえば `0001_v1.sql`）、表は `IF NOT EXISTS` を付けずに作る。wrangler は、マイグレーションが適用済みかをファイル名だけで判定するので、開発中と同じ名前だと、v1 より前の D1 でも適用済みと扱われる（Design Doc 3.6）
2. D1 を作り直す。D1 を消して 5 章の 3 で作り直し、`wrangler.jsonc` の ID を書き換える（5 章の 4）。v1 より前のデータを引き継がないためである（Design Doc 3.6）。作り直しを忘れた D1 では、1 の名前の付け方により、4 の `migrate` が表の重複で失敗し、`deploy` もマイグレーションの照合で止まる
3. 1 と 2 の変更をコミットし、そのコミットに `fortee-reception/v1` のタグを付ける（リポジトリをほかの道具と分け合うので、タグには接頭辞を付ける。リリース名は、接頭辞を除いた `v1` である。Design Doc 8.1）。`deploy` は未コミットの変更があると止まり、デプロイの記録にはリリース名（`git describe`）が残る（Design Doc 8.1）ので、タグを付けたコミットをそのままデプロイする
4. タグを付けた木から、作り直した D1 にマイグレーションを適用し、デプロイする。`migrate` は、作り直した D1 に環境の印を書く

   ```bash
   npm run cli -- migrate --env <環境名>
   ```

   ```bash
   npm run cli -- deploy --env <環境名>
   ```

5. 本番の設定（`config/<環境名>.toml`）で、全イベントの本番の ZIP を取り込んで公開する。v1 以後の環境には、Sandbox の設定と ZIP を公開しない（Design Doc 3.6）
6. スタッフの端末で受付アプリを開き直し、ログインする。v1 の受付アプリは、v1 より前のデータを消して未ログインから始まる（Design Doc 9.6）ので、ログアウトの操作は要らない。どの端末が v1 で同期したかは、書き出しの `devices.csv` で分かる
7. リハーサルを行う（PRD 9 章）。リハーサルの記録は消さない。誤ったチェックインは、取り消しで打ち消す。取り消さなかったチェックインは、リハーサルの書き出しから fortee に一括チェックインされ、一括チェックイン CSV では未チェックインに戻せない（[constraints.md](research/fortee/constraints.md) 6 章）

## 8. v1 以後のデプロイ

v1 以後の環境に配る変更は、マージの前に Design Doc 9.7 の表で、互換性に触れるかを確かめる。デプロイは、マイグレーションを適用してから行う。

```bash
npm run cli -- migrate --env <環境名>
```

```bash
npm run cli -- deploy --env <環境名>
```

`deploy` は、デプロイしたリリース名を Workers の版の記録に残す。どのリリースが動いているかは、次のコマンドで確かめる。

```bash
npx wrangler deployments list --env <環境名>
```

古いリリースに留める環境では、そのリリースのタグから切ったブランチを別の作業ツリーに取り出し、そこから CLI とデプロイを実行する（Design Doc 9.6）。

```bash
git worktree add ../checkin-<環境名> <ブランチ>
```

コードを戻すときは、Design Doc 9.7 の手順に従う。戻す前に、戻せない境目（IndexedDB の版を上げたリリース）をまたがないことを確かめる。

## 9. 秘密の扱い

| 秘密 | 置き場所 | 扱い |
| --- | --- | --- |
| Discord のクライアントシークレット、ギルド ID、ロール ID、`SESSION_SECRET` | 環境ごとの Worker の secret。ローカルは `.dev.vars` | リポジトリに置かない（FR-5）。Discord の値はローカルも本番と同じで、開発者が善良に管理する（4.1）。名前は Design Doc 3.6 |
| Cloudflare の API トークン | 管理者の端末の環境変数 | 管理者ごとに、その管理者のロールが持つ権限のうち、操作に要る権限だけを持つものを作る（バックエンド 4 章）。リポジトリとシェルの履歴に残さない |
| 書き出しのファイル、取り込む ZIP、作業ディレクトリ（`.work/<環境名>/`） | 管理者の端末 | 参加者の情報を含む。リポジトリに置かず、保持期間（PRD 7.4）の後に消す（10 章） |

`SESSION_SECRET` を差し替えると、その環境の全端末が再ログインになる（Design Doc 7.2）。ロールを外したスタッフのセッションをすぐに止めたいときの手段であり、端末のデータは消えない。

## 10. 保持期間の後の削除

保持期間（PRD 7.4）が過ぎたら、その環境のサーバのデータと、管理者の端末に残したファイルを消す。消す対象は Design Doc 8.9 にある。最終の書き出し、fortee の反映結果の確認、全端末のログアウト（PRD 9 章の 7）が済んでいることを、先に確かめる。サーバの削除は取り消せない。

1. API トークンを環境変数に置く（5 章の 2）。削除には、D1 と Workers KV Storage の Edit と、Workers Scripts の Edit が要る（バックエンド 4 章）。以下のコマンドは、対話できる端末で実行する。対話できない環境では、wrangler が確認を待たずに進んだことがある（バックエンド 7.2）
2. Worker を削除する。静的アセットと秘密も消える。先に `--dry-run` を付けて実行し、消す対象が `checkin-<環境名>` であることを確かめる

   ```bash
   npx wrangler delete --env <環境名> --config wrangler.jsonc --dry-run
   ```

   ```bash
   npx wrangler delete --env <環境名> --config wrangler.jsonc
   ```

3. D1 のデータベースを、名前を指定して削除する

   ```bash
   npx wrangler d1 delete checkin-<環境名> --env <環境名> --config wrangler.jsonc
   ```

4. KV の名前空間を、ID を指定して削除する。ID は、`wrangler.jsonc` のその環境の `kv_namespaces` に書いた値である

   ```bash
   npx wrangler kv namespace delete --namespace-id <KV の名前空間の ID> --env <環境名> --config wrangler.jsonc
   ```

   3 と 4 では、消す対象を名前と ID で指定する。`--env` と `--config` は、アカウント（その環境の `account_id`）を選ぶために付ける。コマンドの引数は Wrangler の文書で確かめた（2026-11-10）が、実行は確かめていない。確認の表示が出るかと、`--env` でその環境のアカウントが選ばれるかは、v1 より前に D1 を作り直すとき（6 章）に、同じ形のコマンドで確かめておく

5. 管理者の端末から、作業ディレクトリ（`.work/<環境名>/`）、書き出しの出力、fortee からダウンロードした ZIP を消す。書き出しの出力には、途中で止まった書き出しが `--out` の親ディレクトリに残した一時ディレクトリを含む。複数の管理者が取り込みや書き出しをした場合は、管理者ごとに行う

   ```bash
   rm -rf .work/<環境名>
   ```

6. Discord のアプリケーションから、その環境のリダイレクト URI を外す。`wrangler.jsonc` の env のブロックと `config/<環境名>.toml` は、参加者の情報を含まないので、残してよい
