# フロントエンド: 受付アプリの実装技術の選定

[PRD](../prd.md) の受付アプリ（PWA）を実装する技術を選んだ記録である。対象は、CSS の書き方、画面の描画、言語とビルド、Service Worker、端末内の記憶域、QR コードのデコード、フォントとアイコンである。画面、要素、状態、文言は[画面設計書](../screen-design.md)を正とし、ホスティングと DB は[バックエンド](backend.md)で選んだ構成（1 つの Worker が静的アセットと API を返す）を前提にする。選んだ技術で何をどう作るか（CSS のトークンと書き方、コードの層、Service Worker の方式、テストの方針）は [Design Doc](../design-doc.md) が定める。

記述の確度は次の表記で示す。ライブラリの版と大きさは変わるので、構築の直前に出典（8 章）を見直す。

| 表記 | 根拠 |
| --- | --- |
| 公式 | 提供元の文書、リリースノート、issue、npm の登録情報 |
| 実測 | 検証用の PWA で確かめた。結果は[端末の挙動](device-behavior.md)にある |
| 第三者 | 提供元以外の文書（標準化団体の解説を含む） |
| 推定 | 上記からの推論 |

## 1. 結論

- CSS は Tailwind CSS v4 で書く。ただし既定のテーマ（色、文字サイズ、角丸、影などの値の一覧）をすべて消し、画面設計書 2.2 の色の役割、6 段の文字サイズ、1 種類の角丸だけをトークン（名前を付けた値）として定める。こうすると、色、文字サイズ、角丸、影については、体系の外のクラス（`text-lg`、`rounded-xl`、`shadow-md` など）がそもそも生成されず、lint で見張るのではなく、生成されるクラスの範囲で値を閉じられる。素の CSS とトークンで書く方式とは僅差で、決め手は、どの画面も新しく書くので書く速さの差がそのまま効くことと、この閉じ方の 2 点である（3 章）。daisyUI のような、Tailwind CSS の上に載る部品集は使わない。Cloudflare の Vite プラグインと組み合わせると Tailwind CSS のリセットが重複して出力されるという未解決の報告があるので、構築の最初に確かめる（7 章）。トークンの定め方とクラスの書き方は Design Doc 6.12 にある
- 画面の描画には Preact と Preact Signals を使う（4 章）。React と同じ書き方で、変わった部分だけを更新するので、ホームの状態（停止中、読み取り中、結果）が切り替わっても上の領域などの要素を作り直さない。現在の受付や同期の状態のように多くの画面が読む状態は、Signals で共有できる
- 言語は TypeScript、ビルドは Vite と Cloudflare の Vite プラグインとし、受付アプリと Worker を 1 つのプロジェクトで開発・ビルドする（5.1）。判定（画面設計書 2.4）やチェックイン状態の集約（PRD 7.2）などの規則を、DOM にも Workers にも依存しないモジュールにまとめて受付アプリ、Worker、管理 CLI で共有する方針は、Design Doc 1.2 と 3.1 が定める
- Service Worker は、端末の挙動 11.1 の処理を TypeScript で自分で書き、事前にキャッシュするファイルの一覧をビルドで埋め込む。Workbox と vite-plugin-pwa は使わない（5.2）。端末内の記憶域は IndexedDB を薄く包む idb で扱い、QR のデコードは jsQR を使う。フォントは OS 標準のものを使い、日本語のフォント名を指定の先頭に置く（6 章）

## 2. 選定の条件

### 2.1 PRD、画面設計書、端末の検証から導かれる条件

| 条件 | 由来 | 選定への影響 |
| --- | --- | --- |
| 対象は iOS Safari と Android Chrome の直近 2 メジャーバージョンで、縦持ち、幅 390px（最小 360px）、ライトモード固定、OS の文字サイズに追従しない、日本語のみ | NFR-3, 5、画面設計書 1.2 | レスポンシブの切り替え、ダークモード、テーマの切り替え、多言語が要らず、CSS フレームワークが提供する機能の多くを使わない。一方で、ネスト、カスケードレイヤ、`:has()`、subgrid、コンテナクエリといった最近の CSS の機能は、いずれも Safari 17.2 までに入っており、すべて前提にできる（公式） |
| 受付アプリは 1 つの Worker から静的アセットとして配り、Service Worker で事前にキャッシュしてオフラインで動かす | NFR-2、バックエンド 1.1 | 外部の CDN からライブラリやフォントを読み込めない。ビルドの成果物の一覧を Service Worker に渡す仕組みが要る。実行時に CSS を生成する方式（styled-components など）は、静的な CSS より処理が増えるだけで、本件で得るものがない |
| 画面の要素、色の役割、タップできる大きさ（48px 四方）、注意を要する操作の扱いは画面設計書が定め、値は画面設計書 2.10 と 2.11 による | 画面設計書 1.3, 2.2, 2.5, 2.10, 2.11 | 外から見た目の語彙（カード、影、角丸の既定値）を持ち込む必要がない。役割の名前のまま値を定め、全画面で共有できる方式がよい |
| 停止中、読み取り中、結果は 1 つの画面の状態として切り替わり、上の領域（画面の上 3 分の 1 程度）はどの状態でも同じ位置にある。カメラは読み取り中だけ動かし、結果の間は止める | 画面設計書 S02〜S04、2.6、6 章の予備案 | 画面を移らずに状態だけが変わるので、変わらない部分（上の領域の枠、下の領域の入力中の欄やスクロール位置）を作り直さずに済む描画の仕組みがよい。iOS の実機で再開のたびにカメラの許可を求められる場合は、予備案（結果の間もカメラを止めず、映像を隠すだけにする）に切り替え、映像の要素とカメラのストリームを状態の変化をまたいで保つことになる。この切り替えも、描画の仕組みを変えずに済むものがよい |
| 判定、受付の選択、チェックイン状態の集約の規則を、受付アプリ、Worker、管理 CLI のそれぞれで使う | FR-6, 9, 12〜16, 45, 46、PRD 7.2 | 3 つで同じ言語を使えば、規則を 1 つの実装にまとめられる。Worker は TypeScript と Hono で書く（バックエンド 6 章） |
| ダイアログは選ぶまでほかの操作を受け付けず、アイコンだけのボタンにはアクセシブルな名前を付ける | 画面設計書 2.1, 2.9 | ブラウザの `<dialog>` 要素を使えば、背後の操作を止め、フォーカスを中に閉じ込める処理を書かずに済む |
| iOS のシミュレータで、`font-family` の先頭が `system-ui` か `-apple-system` だと日本語が豆腐（□）になり、後ろに並べた日本語のフォントにも切り替わらなかった。実機では確かめていない | 実測（端末の挙動 10 章） | 日本語のフォント名を指定の先頭に置く。リセット用の CSS や CSS フレームワークが根要素に `system-ui` か `-apple-system` から始まる指定を入れる場合は、上書きが要る。Tailwind CSS の Preflight の既定の `--font-sans` は 4.3.3 以降 `-apple-system` から始まる（公式）が、既定のテーマを消して定め直すので避けられる |

開催（PRD 11 章）までの期間は短く、その前にリハーサル（PRD 9 章）とスタッフの端末の準備がある。新しく覚える道具は日程の危険を増やすので、広く使われていて文書と事例の多いものを選び、端末の検証の知見（端末の挙動 10 章）と Worker の構成（Hono、wrangler）を引き継ぐ。

### 2.2 デザインの方針から導かれる条件

見た目の方針は画面設計書が決めている。結果の帯を画面でいちばん目立つ要素にし、ほかの部分を控えめにする（画面設計書 S04）。CSS の書き方の選定に関わるのは、次の 3 点である。

- 値を閉じた体系にする。色は役割の名前で（画面設計書 2.2）、文字サイズは 6 段で、角丸は押せる要素の 1 種類で定める（段数と角丸の決めと値は画面設計書 2.10。トークンとしての書き方は Design Doc 6.12）。値を手で書く CSS では、文字サイズと角丸が画面ごとに散りやすい。書き方の側で、体系の外の値を書けないようにしたい
- 枠や区切り線に意味を持たせる。枠は「押せる」の意味に限り、押せない情報のまとまりは区切り線で分ける（画面設計書 2.9）。同じ角丸のカードに同じ影を付けて内容を切り分ける見た目は採らない。カードや影を既定の部品に持つ部品集は、この方針と逆の方向に働く
- 書体を選ぶ余地は小さい。日本語の Web フォントは数 MB あり、オフラインのために事前にキャッシュするには大きい。本文は OS 標準のフォントにし、書体を選ぶ余地は、見間違えやすい文字を含むユーザ名とチケット番号に限る（6 章）

## 3. CSS の方式の候補と判断

| 方式 | 例 | 判断 |
| --- | --- | --- |
| UI キット（部品の振る舞いと見た目を提供する） | Ionic Framework、Bootstrap | 採らない。iOS と Android で部品の外観を切り替える仕組みや、カードと影を既定の部品に持つ見た目を、画面設計書に合わせて固定・上書きすることになる。確認のシートを下に引いても閉じない、確定ボタンを開いてから 0.5 秒押せなくする（画面設計書 2.1, 2.5）といった振る舞いも、キットの画面遷移の仕組みと約束事を覚えたうえで設定と上書きで再現することになる |
| Tailwind CSS の上に載る部品集 | daisyUI、Konsta UI、shadcn/ui | 採らない。daisyUI の色の名前（`primary`、`success`、`error`）は画面設計書 2.2 の役割と 1 対 1 に対応しない。拒否、注意を要する操作、確定はどれも赤だが役割が違い、1 つの `error` には寄せられない。対応しない役割を自前のトークンで足すと、色の名前の体系が 2 つ並ぶ。部品の大きさや角丸もテーマの値で決まり、Design Doc 6.12 で閉じる体系の外に出る。shadcn/ui は React と部品の振る舞いを受け持つライブラリを前提にし、Preact では互換層を介することになる（推定） |
| ユーティリティファースト | Tailwind CSS v4、UnoCSS | Tailwind CSS v4 を採る。UnoCSS も考え方は同じだが、利用者と文書の多い Tailwind CSS を選ぶ |
| ビルド時に CSS を生成する CSS-in-TS | vanilla-extract、Panda CSS | 採らない。トークンを型で守れるが、ビルドの仕組みと書き方を新しく覚えることになり、利用者も Tailwind CSS より少ない（推定） |
| 素の CSS とトークン | — | 僅差で採らない（下記） |

本件で必要な汎用の部品は、ボタン、シート、ダイアログ、画面の下の 1 行の知らせ、スイッチ、チェックボックス、ラジオボタンにとどまり、ダイアログの土台にはブラウザの `<dialog>` 要素を使える（Design Doc 6.9）。画面の中心になる部品（結果の帯、チケットの一覧、注意を要する操作のボタン、同期の状態のアイコン）は、どの部品集にもないので自分で書く。部品集を入れても、自分で書く部品は大きく減らない。

Tailwind CSS v4 と、素の CSS とトークンで書く方式は、どちらでも本件の画面を書け、差は大きくない。CSS の書き方は日程を決める要因でもなく、作業の大半は状態、同期、カメラの実装である。差が出るのは次の 4 点で、前の 2 点は Tailwind CSS に、後の 2 点は素の CSS に有利である。

- 値の体系: Tailwind CSS は、既定のテーマを `--*: initial` で消してトークンだけを定めると（公式）、色、文字サイズ、角丸、影について、テーマの値に基づくクラスは生成されない。ただし抜け道は角括弧の任意の値（`text-[15px]`）だけではない。丸括弧で CSS 変数を参照する記法（`bg-(--color-ok)`）と、テーマに依らないクラス（`rounded-full`、`rounded-none`、`text-current` など）も生成される。丸括弧の記法は `[` の検索に掛からないので、検査は丸括弧も対象にするか、クラス名の検証に寄せる（Design Doc）。この生成の確認は総合レビュー側の Tailwind CSS 4.3.4 での実ビルドによるもので、本調査では確かめていない。素の CSS では、トークンを 1 つのファイルに置いてもほかの値は自由に書ける。禁じるには宣言の値にトークンを強いる stylelint のプラグインが要るが、最新の Stylelint 18 に対応していない（公式）
- 書く速さ: Tailwind CSS は、値やクラス名を考えずに要素へ直接書け、CSS のファイルとの行き来もない。どの画面も新しく書く本件では、この差がそのまま効く
- 読みやすさ: Tailwind CSS は要素のクラスが長くなり、TSX から構造を読みにくい。部品をコンポーネントに分け、画面設計書の要素名をコンポーネントの名前に付けて補う
- 依存とビルド: Tailwind CSS は tailwindcss と Vite のプラグインが要る。Cloudflare の Vite プラグインと組み合わせると、本番の CSS に Preflight（Tailwind CSS のリセット）が `@layer` の外にもう 1 つ出るという利用者からの報告があった（issue #19853）。この issue は 2026-05-22 にクローズされているが、修正によるものかは確かめていないので、構築時に本番のビルドで Preflight が 1 つだけ出ることを確かめる（7 章）

本書は前の 2 点を重く見て、Tailwind CSS v4 を採る。短い期間に複数の人が画面を新しく書く本件では、色、文字サイズ、角丸、影について体系の外の値を書けない仕組みのほうが、レビューと lint で見張るより守りやすい（推定）。余白は倍数を自由に書けるので閉じられず、レビューで見る（Design Doc 6.12）。なお、既定のテーマを消した状態で既定のクラス（`text-lg` など）を書いても、CSS が生成されないだけで、画面の上では誤りに気付きにくい。そのため、登録していないクラスを lint で検出する（Design Doc 6.12）。

7 章で Preflight の重複を避けられず、重複を取り除く後処理も入れたくない場合は、素の CSS とトークンに切り替える。`@theme` で定めたトークンは CSS のカスタムプロパティとしても出力される（公式）ので、トークンはそのまま使え、書き直すのはクラスの部分である。

長さの単位は px でよい。画面設計書は、幅 360〜390px と、OS の文字サイズに追従しないことを前提にレイアウトを決めており（画面設計書 1.2）、rem を介す理由がない。rem で書いても文字サイズは OS の設定に追従しない。Android Chrome で OS の文字サイズが rem の値に及ぶのは、ページが `<meta name="text-scale" content="scale">` を置いた場合に限られ（公式）、iOS の Safari は、`-apple-system-body` のフォントを使わない限り Dynamic Type をページに及ぼさない（第三者: CSSWG の解説）。ただし Android Chrome には、OS の文字サイズに合わせてページ全体を拡大する機能があり、これは px で書いても効く（7 章）。

## 4. 画面の描画

描画の仕組みに求めることは、2 章から次の 5 つである。変わった部分だけを更新し、カメラの映像の要素と入力中の欄を作り直さないこと、TypeScript で書けること、事前にキャッシュする大きさが小さいこと、広く使われていて文書と事例が多いこと、多くの画面が読む状態（現在の受付、同期の状態、受付操作の途中の保留）を扱いやすいことである。HTML をサーバで描画する仕組み（SSR）は要らない。受付アプリはオフラインで動く PWA で、最初の HTML は空の殻でよいからである。

| 候補 | 判断 |
| --- | --- |
| Preact と Preact Signals | 採る。変わった部分だけを更新する。React と同じフックと JSX で書け、公式は大きさを 3kB としている。Signals（値が変わったときに、その値を使う部分だけを更新する仕組み）を使えば、多くの画面が読む状態を、コンポーネントの階層を通さずに共有できる |
| フレームワークを使わない（DOM を直接組み立てる） | 採らない。変わった部分だけを更新する処理を自分で書くことになる。状態が変わるたびに DOM を作り直す作りにすると、カメラの映像の要素、入力中の欄、スクロール位置を保つための例外の扱いが、状態の数とともに増える（推定） |
| React | 採らない。書き方は Preact と同じで、ライブラリが大きい（同じカウンタのアプリが Brotli 圧縮後 47.8KB になる比較がある。公式）。Preact で困れば移れる |
| Svelte 5 | 採らない。出力は小さいが、書き方（runes）は Svelte に固有で、React の書き方を知る人もあらためて覚えることになる |
| SolidJS | 採らない。コンポーネントの関数は 1 度しか実行されないので、React の感覚で書くと、値が変わっても画面が更新されない誤りを生みやすい |
| Lit | 採らない。Shadow DOM の内側には外の CSS のクラスが届かないので、Tailwind CSS のスタイルを部品ごとに読み込むことになる |
| hono/jsx/dom | 採らない。Hono はサーバで使うので依存は増えないが、文書は案内の 1 ページで、Preact より事例と周辺のライブラリが少ない（推定） |

## 5. ビルドと配信

### 5.1 言語とビルド

言語は TypeScript にし、型の検査は tsc で行う。ビルドは Vite に任せる。

Vite には Cloudflare の Vite プラグインを組み合わせ、Worker（Hono）と受付アプリを 1 つのプロジェクトで開発する。このプラグインは Worker と単一ページのアプリを 1 つのプロジェクトで扱え、`vite build` で受付アプリを静的アセットとしてビルドし、出力する wrangler の設定に静的アセットのディレクトリを書き込む（公式）。開発中も同じオリジンから静的アセットと `/auth/`、`/api/` を返せるので、Discord のコールバックと Cookie の扱いを、本番と同じ形で試せる。`/auth/` と `/api/` 以下を静的アセットより先に Worker で処理する設定（`run_worker_first`。Design Doc 7.1）をパスの配列で書く形は、プラグイン 1.7.0 と Wrangler 4.20.0 以降で使える（公式）。ビルドとデプロイの流れは Design Doc 3.5 にある。プラグインが構成に合わない場合は、Vite で受付アプリだけをビルドして wrangler の静的アセットのディレクトリに書き出し、Worker は wrangler でビルドする。

### 5.2 Service Worker

Service Worker は、端末の挙動 11.1 の処理を TypeScript で自分で書く（方式は Design Doc 6.11）。Workbox の部品に置き換えると、古い版の Service Worker が消したキャッシュを空で作り直す問題（端末の挙動 10 章）を避けられているかを確かめ直すことになるので、使わない。

版の値とキャッシュするファイルの一覧を手で書くと、上げ忘れたときに端末に古い版が残る（端末の挙動 10 章）。ビルドでハッシュ付きのファイル名と、その一覧を作り、一覧と版を Service Worker に埋め込んで、この手作業をなくす。一覧の埋め込みは、受付アプリの出力を列挙して Service Worker に差し込む小さな Vite のプラグインを書いて行う。vite-plugin-pwa の injectManifest（Service Worker は自分で書き、一覧だけを差し込む方式）も同じことができるが、採らない。vite-plugin-pwa は、Vite の Environment API（1 回のビルドで複数の出力先を扱う仕組み）への対応がまだ取り込まれておらず、複数の環境でビルドすると Service Worker が環境の数だけ作られるという報告も未解決である（公式: リポジトリの issue と pull request）。この報告の条件は Vite の `builder.sharedConfigBuild: true`（既定は false。Nitro が設定する）で、Cloudflare の Vite プラグインがこの設定を使うかは確かめていない。Cloudflare の Vite プラグインは受付アプリと Worker を別の環境としてビルドするので（推定）、条件がそろえばこの報告に当たるおそれがある。本件で要るのは一覧の差し込みだけなので、自分で書いてこの危険を避ける。

## 6. そのほかの部品

| 対象 | 採るもの | 理由 | 確度 |
| --- | --- | --- | --- |
| 端末内の記憶域 | idb（IndexedDB を Promise で扱う薄いライブラリ） | スナップショット、記録（追記だけ）、端末の設定を置く。Dexie は索引による問い合わせや変更の監視を持つが、検索はスナップショットをメモリに読み込んで行い（チケット 1,500 枚）、画面の更新は Signals で足りる。idb は Brotli 圧縮後に約 1.2kB である（公式） | 公式、推定 |
| QR のデコード | jsQR（npm から入れて同梱する） | BarcodeDetector は iOS の Safari にない。jsQR の最後の版は 2021-04 の 1.4.0 で、その後は保守されていない（公式）。jsQR は純粋な JavaScript で、入力は端末のカメラの映像から切り出して長辺 640px 以下に縮めた画像に限る（Design Doc 6.5）ので、保守が止まっていて起こりうるのは、デコードの失敗、例外、処理の遅れにとどまる。例外は捕まえて読み取りを続け、処理時間は実機で確かめる（7 章）。読んだ文字列の形式の検証（FR-11）は、デコードの結果を後段で使うときのためのもので、ライブラリ自体の危険を抑えるものではない。Android エミュレータでは、QR の画像のデコードが 10ms、判定の表示まで 90ms だったが、実カメラの映像では測っていない（実測）。読み取る範囲の切り出しとデコードの手順は端末の挙動 11.2 と Design Doc 6.5、6.8 にあり、切り出した範囲の長辺の上限（640px）が適切かは実カメラでの読み取りで決める（7 章）。読み取りの速さ（NFR-1）を実機のカメラで測り、足りなければ zxing-wasm を使う BarcodeDetector の代替実装（barcode-detector）に替える。その場合、既定では CDN から読み込む WebAssembly のファイル（読み取り用で、圧縮前に約 1.04MiB）を、npm のパッケージから取り出して同じオリジンから配るよう設定する（公式） | 実測、公式、推定 |
| フォント | OS 標準。日本語のフォント名を先頭に置く | 日本語の Web フォントは、事前にキャッシュするには大きい（2.2）。任意で、ユーザ名とチケット番号に限り、`I`・`l`・`1` や `0`・`O` を見分けやすい欧文フォントを同梱する。候補は、文字の判別しやすさを目的に作られた Atkinson Hyperlegible Next（OFL。欧文の文字だけを持つ。公式）である。実際のユーザ名とチケット番号を並べて見分けやすさを確かめ、採るかを決める | 公式、推定 |
| アイコン | Lucide（ISC ライセンス）のうち、使うものだけを SVG のまま Preact のコンポーネントとして取り込む | 画面設計書の同期の状態、操作の種類、判定結果のアイコンを、線の太さのそろった 1 つの集まりから選べる（推定）。足りない形は、同じ線の太さで描き足す | 推定 |
| 音 | Web Audio API で、波形を計算して鳴らす | 音のファイルを持たずに済む。iOS で音を鳴らせる状態にする処理は端末の挙動 11.3 にあり、Design Doc 6.8 がそれに従う。iOS の消音モードでは鳴らなくてよい（画面設計書 2.4） | 実測 |
| 時刻の表示 | `Intl.DateTimeFormat` に設定のタイムゾーンを渡す | 画面設計書 2.9 の書式（当日は「08:30」、前日以前は「11/28 08:30」）は、この API で組み立てられる。日付のライブラリは要らない | 推定 |

## 7. 構築の最初に確かめること

このうち、振り分け（ローカルの `vite dev` と `vite preview`）、Tailwind CSS のリセットの重複と既定のテーマの消去、Preact 11 と周辺のライブラリ、Service Worker へのファイルの一覧の埋め込みは、基盤の構築で確かめた。結果は Design Doc 12.1 にある。デプロイ先での振り分けと、実機での確認は残っている。

| 確認すること | 方法 | 結果による判断 |
| --- | --- | --- |
| Cloudflare の Vite プラグインで、静的アセットと Worker の振り分けが動く | 雛形を作り、`vite dev` とデプロイ先で、`/auth/` と `/api/` が Worker に、それ以外が静的アセットに届くことを確かめる | 動かなければ 5.1 の代わりの構成にする |
| Tailwind CSS のリセットの重複 | 雛形の本番のビルドで、CSS に Preflight が `@layer` の外にもう 1 つ出ていないかを確かめる。issue #19853 の報告の構成は、Worker のほかにサーバで描画する環境も持つフレームワークで、受付アプリと Worker だけの構成で起きるかは分からない（推定） | 起きれば、重複を取り除く後処理を入れるか、素の CSS とトークンに切り替える（3 章） |
| Tailwind CSS の既定のテーマの消去 | `--*: initial` の後で、`text-lg`、`rounded-xl`、`shadow-md` が生成されないこと、`p-4` と `h-12` が、画面設計書 2.10 の余白の決め（4px の倍数）どおりに 16px と 48px になること、`no-unknown-classes` が既定のクラスを検出すること、`@theme static` で使っていないトークンも CSS 変数として出力されることを確かめる。余白の基準（`--spacing`）の扱いは、第三者の資料でしか確かめていない | 生成のされ方が違えば、Design Doc 6.12 のトークンの定め方を直す |
| Preact 11 と周辺のライブラリ | Preact 11 は 2026-09-30 に出た新しいメジャー版である（公式）。雛形で、Vite で JSX を変換する設定、@preact/signals、画面のテストに使うライブラリが Preact 11 で動くことを確かめる | 動かないものがあれば Preact 10 を使う |
| Service Worker へのファイルの一覧の埋め込み | Design Doc 6.11 のプラグインで、受付アプリの出力だけが一覧に入り、Worker の出力が入らないこと、版を上げたときに古いキャッシュが消えることを確かめる | 一覧に過不足があれば、プラグインが列挙する環境と出力を直す |
| Android の OS の文字サイズ | Android の実機で OS の文字サイズを最大にし、インストールした受付アプリで、表示の幅（`window.innerWidth`）と各画面の表示を確かめる。Chromium は 2023 年に、Android でページの拡大率の既定値を OS の文字サイズに合わせる変更を告知している（公式）。いまの提供範囲と、インストールした Web アプリにも及ぶかは確かめていない | 表示の幅が 360px を下回るなら、最小対応幅（画面設計書 1.2）とスタッフへの案内（OS の文字サイズを標準に戻す）を画面設計書に返す |
| QR の読み取りの速さ | 実機の iOS と Android で、上の領域に見えている範囲を切り出してから、画面に出した QR とウォレットの QR を jsQR で読み、読み取りから判定の表示までの時間を測る。切り出した範囲の長辺の上限（640px）を変えたときの読み取りやすさも見る | 上限を読み取りやすさで決める。NFR-1 を満たさなければ barcode-detector に替える（6 章） |
| 日本語の表示 | 実機の iOS で、画面設計書 2.10 のフォントの並び（並びの先頭を日本語のフォント名にする制約は Design Doc 6.12）で日本語が表示されることを確かめる。豆腐はシミュレータでの結果である（端末の挙動 10 章） | 豆腐になれば指定を直す |
| Service Worker の更新直後の起動（iOS） | Design Doc 6.11 の方式で版を上げ、実機の iOS で更新直後に起動する。iOS のシミュレータでは、更新直後の 1 回目の起動で画面の初期化が途中で止まった（端末の挙動 10 章） | 再現すれば、原因を調べてからスタッフの端末の準備に進む |

## 8. 出典

ライブラリの版は、導入したものは `package-lock.json` に固定した版（2026-11-12。Design Doc 14 章）で、「未導入」と添えたものと採らないものは、2026-11-09 に npm の登録情報で確かめた最新の版である。括弧内はページに表示された更新日である。

| パッケージ | 版 | 備考 |
| --- | --- | --- |
| tailwindcss | 4.3.4 | @tailwindcss/vite も同じ版 |
| preact | 11.1.1 | 11.0.0 は 2026-09-30 |
| @preact/signals | 2.11.4 | Preact 11 に対応 |
| hono | 4.13.16 | |
| @cloudflare/vite-plugin | 1.67.0 | Vite 6〜8 に対応 |
| vite-plugin-pwa | 2.0.0 | 採らない（5.2） |
| jsqr | 1.4.0 | 2021-04-24。未導入 |
| zxing-wasm、barcode-detector | 3.1.6、3.2.3 | jsQR で足りなければ使う |
| idb | 8.0.4 | |

- Tailwind CSS: [Compatibility](https://tailwindcss.com/docs/compatibility)、[Theme variables](https://tailwindcss.com/docs/theme)、[Hover, focus, and other states（属性の変種、`@custom-variant`）](https://tailwindcss.com/docs/hover-focus-and-other-states)、[Adding custom styles（任意の値、`@utility`）](https://tailwindcss.com/docs/adding-custom-styles)、[CHANGELOG（4.3.3 の既定のフォントの変更）](https://github.com/tailwindlabs/tailwindcss/blob/main/CHANGELOG.md)、[issue #19853（Cloudflare の Vite プラグインとの組み合わせで Preflight が重複する）](https://github.com/tailwindlabs/tailwindcss/issues/19853)。Preflight と既定のテーマは、npm の tailwindcss 4.3.5 の `preflight.css` と `theme.css` で確かめた
- 第三者: [Tailwind CSS の余白の解説（`--spacing`）](https://mintlify.com/tailwindlabs/tailwindcss/customization/spacing)
- [eslint-plugin-better-tailwindcss](https://www.npmjs.com/package/eslint-plugin-better-tailwindcss)、[v4.0.0 のリリースノート（`no-unknown-classes` への改名）](https://newreleases.io/project/github/schoero/eslint-plugin-better-tailwindcss/release/v4.0.0)
- [stylelint-declaration-strict-value](https://www.npmjs.com/package/stylelint-declaration-strict-value)（Stylelint 16〜17 に対応。採らない）
- [Preact](https://preactjs.com/)
- Cloudflare: [Vite plugin の静的アセット](https://developers.cloudflare.com/workers/vite-plugin/reference/static-assets/)（2026-10-28）、[Vite plugin の Get started](https://developers.cloudflare.com/workers/vite-plugin/get-started/)（2026-10-12）、[Vite plugin の Vite Environments](https://developers.cloudflare.com/workers/vite-plugin/reference/vite-environments/)、[run_worker_first の変更の告知](https://developers.cloudflare.com/changelog/2025-06-17-advanced-routing/)（2025-06-17）
- vite-plugin-pwa: [injectManifest](https://vite-pwa-org.netlify.app/guide/inject-manifest.html)、[issue #940（`builder.sharedConfigBuild: true` のとき Service Worker が環境ごとに生成される。2026-07-28 起票、2026-11-10 時点で未解決。メンテナは後継の unplugin-pwa で直す方針）](https://github.com/vite-pwa/vite-plugin-pwa/issues/940)、Environment API に対応する pull request [#786](https://github.com/vite-pwa/vite-plugin-pwa/pull/786) と [#903](https://github.com/vite-pwa/vite-plugin-pwa/pull/903)（いずれも 2026-11-09 時点で未マージ）
- [MDN の互換性データ](https://github.com/mdn/browser-compat-data)（@mdn/browser-compat-data 8.1.8、2026-11-02）。ネスト、`@layer`、`:has()`、subgrid、コンテナクエリ、`<dialog>` の `closedby` の対応版
- [HTMLDialogElement の cancel イベント](https://developer.mozilla.org/en-US/docs/Web/API/HTMLDialogElement/cancel_event)（2026-10-26）、[HTML の仕様（閉じる要求とユーザの操作）](https://html.spec.whatwg.org/multipage/interaction.html)、[New in Chrome 120（Android の戻る操作と dialog）](https://developer.chrome.com/blog/new-in-chrome-120)
- [`<meta name="text-scale">`](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/meta/name/text-scale)（2026-09-04）、[Chromium の Page Zoom の告知](https://groups.google.com/a/chromium.org/g/blink-dev/c/rTNCw0lHmZk)（2023）
- 第三者: [CSSWG の `env(preferred-text-scale)` の解説](https://drafts.csswg.org/css-env-1/explainers/env-preferred-text-scale.md)（iOS の Dynamic Type とページの関係）
- [jsqr（npm）](https://www.npmjs.com/package/jsqr)、[cozmo/jsQR](https://github.com/cozmo/jsQR)、[zxing-wasm](https://github.com/Sec-ant/zxing-wasm)、[barcode-detector](https://github.com/Sec-ant/barcode-detector)
- [idb](https://github.com/jakearchibald/idb)
- Atkinson Hyperlegible Next: [Google Fonts のリポジトリ](https://github.com/google/fonts/tree/main/ofl/atkinsonhyperlegiblenext)、[Braille Institute](https://www.brailleinstitute.org/freefont/)
