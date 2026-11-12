# 端末の挙動: 検証結果と実装に引き継ぐ知見

[画面設計書](../screen-design.md) 6 章が前提にする端末の挙動（Discord ログインの戻り先、カメラの許可、音、振動、画面のスリープ、オフラインでの起動、データの保持）を、検証用の最小限の PWA で確かめた結果と、その PWA から受付アプリに引き継ぐ知見と実装をまとめる。検証用の PWA のコードはリポジトリに残さないので、引き継ぐコードは 11 章に全文を置く。

## 1. 確かめた環境と確度

結果には、どの環境で確かめたかを添える。

| 表記 | 環境 |
| --- | --- |
| 実機 | iOS 27 の iPhone（Safari 27.0.1）。ホーム画面に追加した Web アプリとして開いた。操作と目視は検証者が行い、PWA のログを受け取ったものと、検証者の申告だけのもの（「申告」と書く）がある |
| iOS シミュレータ | Xcode の iOS 26.3 シミュレータ（iPhone 17）。カメラは合成映像で、消音スイッチ、触覚、自動ロックはない |
| Android エミュレータ | Android Studio のエミュレータ（Android 17、API 37、Chrome 145）。カメラは仮想シーンの映像で、ライトはない。Google アカウントのない状態ではショートカット、ある状態では WebAPK としてインストールした |
| PC | PC の Chromium |
| 公開情報 | Discord が配信するファイルと、第三者の記事。3.2 で使う |

シミュレータとエミュレータの結果は、実機の代わりにはならない。実機で同じ傾向になるかを確かめる手がかりとして残す。iOS 26 と Android は、実機ではまだ確かめていない（12 章）。

## 2. 結果の一覧

| 項目 | 実機（iOS 27） | iOS シミュレータ（26.3） | Android エミュレータ | 設計での扱い |
| --- | --- | --- | --- | --- |
| Discord から戻る画面 | ホーム画面アプリ | ホーム画面アプリ | ホーム画面アプリ | S01 は同じ画面のまま認可画面へ移動する（3 章） |
| 戻ったときの読み込み直し | 読み込み直される | 読み込み直される | 同じ画面で開けば読み込み直される | 戻った画面を新しい起動として扱う |
| カメラの許可を求められる時機 | 初回だけ（申告） | 起動のたびに求められる | 初回だけ | 前提は画面設計書 6.1 による。起動の中の再開でも求められる端末があれば予備案（画面設計書 6 章） |
| 拒否した後に、ページから再び許可を求められるか | 未確認 | 同じ起動の中では求められない。起動し直すと求められる | 求められない | S03 の「拒否された」状態のとおり |
| 消音モードで音が鳴るか | 鳴らない（申告） | 確かめられない | ― | 鳴らなくてよいとし、運用で消音モードを切ってもらう（画面設計書 2.4） |
| バックグラウンドから戻った後の音 | 未確認 | 音声の出力は動作中のまま | 音声の出力は動作中のまま | 音を鳴らしうる画面へ進むタップのたびに鳴らせる状態にし直す（画面設計書 2.4） |
| 振動・触覚 | 出せない | 確かめられない | 出る | iOS では使わない（画面設計書 2.4） |
| Screen Wake Lock | 効いた（申告） | 取得できる（効果は確かめられない） | 取得できる（効果は確かめられない） | 画面設計書 2.6 のとおり |
| ライト | ― | ― | ― | 使わない（画面設計書 S03） |
| オフラインでの起動 | 未確認 | サーバに届かない状態で起動できた | 機内モードで起動し、QR の判定と音まで動いた | PRD の AC-2 の前提は、エミュレータでは成り立った |
| データの保持（数日） | 未確認（数日おいた確認は終わっていない） | ― | ― | ― |

## 3. Discord ログインの戻り先

### 3.1 確かめたこと

検証用の PWA は、ログインを始めるときに sessionStorage と localStorage に印を入れ、Discord から戻った画面でその印を読む。localStorage の印が残っていれば、ログインを始めたのと同じ保存領域（同じアプリ）に戻っている。sessionStorage の印も残っていれば、同じ閲覧コンテキスト（同じ画面）に戻っている。state Cookie の照合結果は補助として見た。iOS では、Safari のタブで付いた Cookie をホーム画面アプリから読めたので、Cookie が一致しても同じ保存領域に戻ったとは言えないためである（10 章）。認可画面への移り方は、「同じ画面」（`location.href` での移動）と「新しい画面」（`target=_blank` での移動）の 2 つを試した。

iOS の実機では、端末に Discord アプリが入っていたが、どちらの移り方でも Discord アプリは開かず、ホーム画面アプリの上に重なる画面で認可画面が開いた。同じ画面から承認すると、ホーム画面アプリの中で `/?login=ok` が新しく読み込まれ、印はどちらも残っていた。新しい画面から承認しても、ホーム画面アプリ（`display-mode: standalone`）の中で読み込まれたが、sessionStorage の印はなく、ログインを始めた画面とは別の閲覧コンテキストに着いていた。ログインを始めた画面は、表示に戻らなかった。このログは Discord にログイン済みの状態のものである。未ログインの状態から試しても、同じくホーム画面アプリに戻り、画面は読み込み直された（申告。選んだログイン手段と既定のブラウザは記録していない）。

iOS シミュレータ（Discord アプリなし、Discord に未ログイン）でも、どちらの移り方でも Safari には切り替わらず、ホーム画面アプリの上に重なる画面（左上に閉じるボタン、右下に Safari で開くボタン）で認可画面が開いた。同じ画面から承認すると実機と同じ結果になった。承認せずに重なった画面を閉じると、ログインを始めた画面が読み込み直されずに残っていた。

Android エミュレータでは、どちらの移り方でも Chrome のタブには移らず、インストールした Web アプリの中で、上部に閉じるボタンとドメインの帯が付いた画面として認可画面が開いた。ショートカットと WebAPK で結果は同じだった。同じ画面から承認すると Web アプリの中で読み込み直され、印はどちらも残っていた。拒否した場合も `/?login=denied` で同じく読み込み直された。新しい画面から移ると、ログインを始めた画面の上に帯の付いた別の画面が重なり、承認しても拒否しても、その重なった画面のまま戻ってきた（sessionStorage の印なし）。Discord アプリ（352.17）を入れてログインした状態でも、Discord アプリは一度も開かなかった。Discord アプリがリンクとして受け持つ URL のうち認可に関わるのは `https://discord.com/connect/authorize` と `discord://action/oauth2/authorize` だけで、受付アプリが開く `https://discord.com/oauth2/authorize` は含まれない（`adb shell dumpsys package com.discord` で確認）。また、Discord アプリにログインしても Chrome の中の Discord はログイン済みにならず、Web のログイン画面にも認可画面にも、Discord アプリに切り替えるボタンやリンクはなかった。

確かめた条件では、コールバックが既定のブラウザに着く経路はなかった。どの環境でも、同じ画面から移れば、ログインを始めたのと同じアプリと閲覧コンテキストに戻り、画面は読み込み直された。新しい画面から移ると、戻り先がログインを始めた画面とは別の画面になる。したがって、S01 の「Discord でログイン」は同じ画面のまま認可画面へ移動し、戻った画面を新しい起動として扱う。

### 3.2 Universal Links とアプリ内ブラウザ

実機の結果は、公開情報とも合う。

iOS は、ドメインが配信する `apple-app-site-association`（どのパスを対応アプリで開くかの定義）に従って Universal Links を処理する。discord.com の定義（オリジンと Apple の CDN の両方から取得して読んだ）では、`/oauth2/authorize` のうちクエリに `response_type` があるものは除外され、それ以外の `/oauth2/authorize`、`/mweb-handoff`、`/login/one-time` はアプリで開く。定義は先頭から順に評価され、除外が先にあるので、受付アプリが使う認可コードフロー（`response_type=code`）の URL では Discord アプリは起動しない。

iOS 12.2 以降、ホーム画面 Web アプリがスコープ外の URL へ移動すると、Safari ではなくアプリ内のブラウザで開く（Firtman の記事）。アプリ内のブラウザは、開いた元のホーム画面 Web アプリとストレージを共有し、Safari とは共有しない。アプリ内のブラウザでスコープ内の URL へ移ると（POST、JavaScript によるリダイレクト、リンクのいずれでも）、アプリ内のブラウザが閉じ、その URL をホーム画面 Web アプリの画面で読み込む。`target=_blank` で開いた場合は、アプリ内のブラウザを閉じると元の画面の状態が戻り、`target=_blank` なしで移動した場合は元の画面が破棄され、戻ると読み込み直しになる。3.1 の実機とシミュレータの結果は、この記述のとおりだった。

既定のブラウザに着きうる経路として残るのは、受付アプリ内のブラウザで Discord に未ログインのとき、ログイン画面で Discord アプリを使ったログイン（Discord の Web クライアントでは "Mobile Web Handoff" と分類され、`/mweb-handoff` を Discord アプリで開く）を選んだ場合である（推定）。Discord アプリが Web 側へログイン状態を返すとき、iOS にはほかのアプリから特定のホーム画面 Web アプリを指定して URL を開く手段がないので、URL は既定のブラウザで開き、OAuth の続きとコールバックもそこに着く。既定のブラウザは iOS 14 以降ユーザが変えられるので、着く先は Safari とは限らない。一度受付アプリ内のブラウザで Discord にログインすれば、ログイン状態は受付アプリのストレージに残るので、次回からはログイン画面を経ずに認可画面が出るはずである（推定）。

### 3.3 残る条件

次の条件は確かめていない。

- Discord アプリがない iOS の実機
- iOS で、未ログイン時に Discord アプリを使ったログインを選んだ場合
- 既定のブラウザが Safari 以外の場合
- iOS 26 の実機、Android の実機
- 受付アプリ内の Discord のログイン状態が、次の起動まで残るか

まず通常のリダイレクト型 OAuth で実装し、既定のブラウザに着く経路が実際に見つかった場合だけ、3.4 の手順を加える。

### 3.4 セッションの扱いと、予備案のワンタイムコード

OAuth の `state` は、認可要求を出したブラウザの Cookie と結びつけて照合するときに CSRF を防ぐ（RFC 6749 §10.12、RFC 9700）。認可画面へ移動する前に `state` を Cookie に保存し、コールバックで照合する。セッションのトークンは localStorage に置かず、HttpOnly Cookie として設定する。Design Doc 7.2 では、Discord のコールバックの応答で発行し、その後の受付アプリ自身の `fetch` がそれを送る。3.1 のとおりコールバックはホーム画面アプリの中で読み込まれるので、Cookie は受付アプリのストレージに入る見込みだが、コールバックの応答で付けた Cookie をその後の `fetch` で送ることは検証していない（PoC のコールバックは `state` を照合して消すだけで、セッションの Cookie は発行していない）。このため、受付アプリ、Discord のコールバック、API は同じオリジンで配信する（[バックエンド](backend.md) 2.2）。

受付アプリが生成したセッション ID を `state` に入れ、サーバをポーリングしてトークンを受け取る方式は採らない。コールバックが別のブラウザに着いた場合、そこには受付アプリの Cookie がないので `state` は CSRF を防がず、セッション ID を知る第三者（認可 URL とコールバック URL に含まれるので、履歴、アクセスログ、Referer から漏れうる）がトークンを受け取れる。漏洩がなくても、攻撃者が自分でセッション ID を作ってポーリングを始め、それを `state` に入れた認可 URL をスタッフに開かせて承認させれば、スタッフとしてログインできる（端末やブラウザをまたぐ認証フローで知られている攻撃。RFC 10027（BCP 247、2026 年）が整理している）。

既定のブラウザに着く経路が見つかった場合は、スタッフ自身が二つの画面を結びつける次の手順を加える。

1. 受付アプリがサーバにログイン開始を要求する。サーバは開始記録を作り、その ID を HttpOnly Cookie で受付アプリに返す。`state` には開始記録と対応づけた推測できない値を入れる
2. コールバックに開始記録の Cookie があれば（受付アプリに戻った場合）、そのままログインを完了する
3. Cookie がなければ（既定のブラウザに着いた場合）、サーバは Discord のユーザ情報を開始記録に保存し、短いワンタイムコードを画面に表示する
4. スタッフがそのコードを受付アプリに入力すると、サーバは Cookie の開始記録とコードを照合し、受付アプリにセッションを発行する

コードは有効期限を短くし、試行回数を制限し、一度使ったら無効にする。既定のブラウザの画面には、コードを他人に伝えないよう注記する。攻撃者がスタッフからコードを聞き出せば突破できるが、認可 URL を開かせて承認させるだけで乗っ取れる方式より、攻撃に必要な手順が一つ増える。画面側では、S01 にコード入力の状態と、既定のブラウザ側でコードを表示する画面を加える（画面設計書 6 章）。

## 4. カメラの許可

実機では、許可を求められたのは初回だけだった（申告）。拒否した後の挙動は確かめていない。

iOS シミュレータでは、起動のたびに許可を求められ、Permissions API の状態も起動のたびに `prompt` に戻った。拒否すると、同じ起動の中では確認が出ずに `getUserMedia` が 1ms で `NotAllowedError` になり、起動し直すと再び確認が出た。拒否した後も、Permissions API は `denied` ではなく `prompt` を返した。バックグラウンドに回ってカメラが止まった後に開始し直したときは、確認が出ず、`getUserMedia` は 2ms で返った。

Android エミュレータでは、初回に、Chrome がこのサイトに許可するかの確認と、OS が Chrome アプリにカメラを許可するかの確認が続けて出た。サイトに「サイトの閲覧中は許可」を選ぶと、起動し直しても、1 回の起動の中で止めて再開しても、確認は出なかった（再開したときの `getUserMedia` は 102ms で返った）。「許可しない」を選ぶと、同じ起動の中で再び求めても確認は出ず、`getUserMedia` は 9ms で `NotAllowedError` になり、Permissions API は `denied` を返した。許可し直すには、Chrome のサイト情報で権限をリセットする必要がある。

WebKit の bug 報告には、実機の申告と食い違う利用者の報告が 2 つある。iOS 26.6.2 の実機のホーム画面アプリで、起動のたびに許可を求められたという報告（bug 327237）と、iOS 16.3.1 のホーム画面アプリで、1 分以上あけて読み取ると再び求められたという報告（bug 215884）である。後者では WebKit の担当者が、WKWebView では取り込みをしない状態が 1 分続くと次は再び求めると説明している。実機では、止めてから再開するまでの間隔を変えた確認をしておらず、どちらが正しいかは確かめていない（画面設計書 6.1）。

ここに挙げた時間は、`getUserMedia` を呼んでから返るまでの時間である。映像が画面に出るまでの時間は測っておらず、どちらも仮想のカメラなので、実機のカメラを起動する時間を表していない。

カメラを再開するたびに許可を求められる場合の予備案（S03 と S04 の間でカメラを止めない。画面設計書 6 章）は、1 回の起動の中で再開したときにも許可を求められる場合に限って使う。そうなった環境はなく、iOS 26.3 のシミュレータも、起動のたびには求めたが、起動の中の再開では求めなかった。iOS の実機で、起動の中の再開を個別に確かめていないので、12 章に残している。

## 5. 音

実機では、タップの後に音が鳴った。消音モードのときは鳴らなかった（申告）。このときの鳴らし方（Web Audio か audio 要素か）と `navigator.audioSession.type` の組み合わせは記録していない。検証用の PWA の既定は Web Audio と `playback` である。消音モードのときに鳴らす方式は探さない。音が要る会場では、スタッフに消音モードを切ってもらうよう案内すれば足りる（画面設計書 2.4）。

iOS シミュレータでは、タップの中で `AudioContext` を作ると `running` になり、バックグラウンドから戻った後も `running` のままだった。`navigator.audioSession` はあり、初期値は `auto` だった。Android エミュレータでは、`AudioContext` は最初から `running` で、Chrome が音声の出力を始めたことを Android の記録で確かめた。どちらも、実際に聞こえるかは確かめられない。

## 6. 振動と触覚

Android エミュレータでは `navigator.vibrate` があり、成功は 60ms を 1 回、注意は 60ms を 2 回、拒否は 400ms を 1 回振動したことを Android の記録で確かめた（長さは仮に決めた値である）。

iOS には `navigator.vibrate` がない。代わりに、`<input type="checkbox" switch>` を切り替えたときの触覚を使う方法を実機で試した。label をスクリプトから click する方式、描画した label を click する方式、switch を直接 click する方式のどれでも、タップの中で呼んでも、触覚は出なかった。switch を指で直接切り替えたときだけ触覚が出たので、端末の触覚の設定は有効である。iOS 26.5 から `label.click()` 経由では触覚が出なくなったという第三者の報告もある。iOS 27 のホーム画面アプリでは、スクリプトから触覚を出す手段はない。受付アプリでは iOS で触覚を使わず、音と画面の表示で判定結果を伝える。

## 7. 画面のスリープ

実機では、Screen Wake Lock を取得すると、OS の自動ロックが働かなかった（申告）。iOS シミュレータと Android エミュレータでは、取得でき、バックグラウンドに回ると解放された。Android では、取得すると Web アプリの画面に「画面をつけたままにする」指定（`FLAG_KEEP_SCREEN_ON`）が付いた。どちらも自動で画面を消さないので、効果は確かめられない。

Wake Lock はページが隠れると解放されるので、受付アプリは表示に戻ったときに取り直す。

## 8. オフラインでの起動

Android エミュレータ（WebAPK）では、機内モードにして Chrome を止めてから Web アプリを起動した。画面は Service Worker のキャッシュから表示され、`navigator.onLine` は `false` になった。失敗した通信は、サーバの設定を取りに行く要求だけだった。この状態で、カメラの開始（許可は以前に済んでいたので確認なし）、QR の読み取り、判定、音までが動いた。エミュレータのカメラにはテスト用 QR を写せないので、QR の画像をキャンバスに描いて、カメラの映像と同じ読み取りと判定の処理に渡した。jsQR のデコードは 10ms で、判定の表示まで 90ms だった。

iOS シミュレータには機内モードがないので、ローカルのサーバを止めて、Web アプリを終了してから起動し直した。画面は Service Worker のキャッシュから表示された。ネットワーク自体はつながっているので、`navigator.onLine` は `true` のままだった。PC の Chromium でも、オフラインでの再読み込みで画面が表示された。

実機の機内モードでの起動は確かめていない。

## 9. データの保持

初回起動の日時と起動回数を IndexedDB、localStorage、Cookie のそれぞれに保存し、開くたびに、どれが残っているかを表示して確かめた。

- iOS シミュレータでは、3 回の起動をまたいで、IndexedDB、localStorage、Cookie のどれにも初回起動の日時が残った。`navigator.storage.persist()` は `true` を返した
- Android エミュレータでは、Chrome のタブとインストールした Web アプリが、IndexedDB、localStorage、Cookie を共有していた。`navigator.storage.persist()` は、ショートカットでは `false`、WebAPK では `true` を返した
- 実機で数日おいて開き直す確認は、終わっていない。Safari は長期間使わないサイトの記憶域を消すことがあるとされる（未検証）ので、会場に入る前にネットワークのある場所でログインとデータの取得を済ませる手順（PRD 9 章）は、この確認の結果にかかわらず残す

## 10. 実装に引き継ぐ知見

受付アプリの実装で同じことに出会いうる事柄を挙げる。

- **ホーム画面への追加（iOS）:** iOS 26.3 のシミュレータでは、「ホーム画面に追加」は「共有」の最初の列になく、「もっと見る」の中にあった。名前は `apple-mobile-web-app-title` の値になり、「Web アプリとして開く」は最初からオンだった。起動すると `display-mode: standalone` と `navigator.standalone === true` になった
- **Safari の Cookie（iOS）:** Safari のタブで付いた Cookie を、ホーム画面に追加した Web アプリの最初の起動から読めた（実機、シミュレータ）。localStorage は引き継がれなかった。WebKit の公式ブログ（WebKit Features in Safari 17.2、2023-12-11）によると、iOS 17.2 以降はホーム画面に追加するときに Cookie だけが複写され、ほかのストレージは複写されず、追加の後はデータを共有しない。観察はこれと合う。Cookie が読めることを、同じ保存領域にいることの根拠にはできない（NFR-8）
- **`navigator.onLine`:** 回線があるかしか表さず、サーバに届くかは表さない。iOS シミュレータでは、サーバを止めても `true` のままだった（8 章）。受付アプリでは、`onLine` が偽の状態だけを「オフライン」とし、回線はあるが要求が届かない失敗は「同期の失敗」として扱って再試行を続ける（Design Doc 6.6、画面設計書 2.3）。到達の失敗を「オフライン」に含めると、回線が変化しない限り `online` イベントが来ず、回復を知る手段がなくなる
- **Permissions API:** カメラの許可を拒否した後、iOS シミュレータは `prompt` を、Android は `denied` を返した。iOS では Permissions API で拒否を見分けられないので、拒否は `getUserMedia` の `NotAllowedError` で判定する
- **UA（iOS）:** シミュレータの UA の OS の部分は `iPhone OS 18_7` のままで、iOS の版は `Version/26.3`（Safari の版）にしか現れなかった。iOS の版を UA の OS の部分から判定しない
- **フォント（iOS）:** `font-family` の先頭が `system-ui` か `-apple-system`（等幅では `ui-monospace`）だと、シミュレータでは日本語がすべて豆腐（□）になり、後ろに並べた Hiragino Sans にも切り替わらなかった。日本語のフォントを先頭に置いて直った。実機で同じことが起きるかは確かめていない（[フロントエンド](frontend.md) 7 章）
- **Service Worker のキャッシュ:** `fetch` の処理で `caches.open()` を使うと、新しい版の `activate` が古いキャッシュを消した後に、まだ動いている古い版の Service Worker が、消したキャッシュを空で作り直すことがある（iOS シミュレータで、古い版のキャッシュ名が残った）。`caches.match(req, { cacheName })` で引けば作り直さない。この修正を入れた版から次の版に上げたときに、iOS で残らなくなるかは確かめていない
- **Service Worker の更新直後（iOS）:** iOS シミュレータで、古い版から新しい版に更新した直後の 1 回目の起動で、画面の初期化が途中で止まった。Web アプリを終了して開き直すと正常に動いた。原因は確かめていない（フロントエンド 7 章）
- **Service Worker の版:** 検証用の PWA はファイルを変えるたびに手で版の値を上げ、キャッシュするファイルの一覧も手で書いていた。上げ忘れると端末に古い版が残る。受付アプリでは、ビルドで一覧と版を埋め込む（Design Doc 6.11）
- **wrangler dev:** wrangler 4.124.0 の `wrangler dev` は、実行中にファイルを変えても古い ETag を返し続け、ブラウザが Service Worker の更新を検出できなかった。ローカルで更新を確かめるときは再起動する
- **WebAPK とショートカット（Android）:** Chrome でのインストールは、Google Play を通じて単体のアプリ（WebAPK）として入る場合と、Chrome のショートカットとして入る場合がある。Google アカウントのない端末ではショートカットになり、アカウントにログインした後は WebAPK になった。WebAPK はアイコンに Chrome のバッジが付かず、`adb shell pm list packages | grep webapk` でパッケージが見つかる。LAN の IP アドレスに `http://` で接続すると安全なコンテキストにならず、WebAPK にならない。Service Worker の版を上げても WebAPK は作り直されず、manifest の name、icons、scope、start_url などを変えたときだけ作り直される。scope を `/` にすると、WebAPK はこのオリジンの URL を開くインテントを受け持つ
- **インストールの案内（Android）:** Chrome のタブでは `beforeinstallprompt` が届き、ページのボタンから `prompt()` を呼ぶと、Chrome の「Install app」、続いて「Add to home screen」の確認が出た。ただし、`beforeinstallprompt` はページを開いてすぐには届かないことがある。その場合も、Chrome のメニューからインストールできる
- **外部サイトへの移動（Android）:** インストールした Web アプリから別のオリジンへ移ると、Chrome のタブには移らず、Web アプリの中で閉じるボタンとドメインの帯が付いた画面になる。自分のオリジンに戻ると帯は消える

## 11. 受付アプリに移す実装

### 11.1 Service Worker

検証用の PWA の Service Worker を次に示す（キャッシュ名だけ受付アプリ向けに改めた）。アプリシェルを事前にキャッシュし、キャッシュ優先で返す。`/auth/` 以下と別のオリジンへの要求は扱わず、ネットワークに任せる。受付アプリでは `/api/` 以下も同じく扱わない。これらは Worker が処理する（[バックエンド](backend.md) 1.1）ので、応答をキャッシュから返さないためである。`VERSION` と `SHELL` は、受付アプリではビルドで作るファイルの一覧を埋め込む（Design Doc 6.11）。

```js
// アプリシェルを事前にキャッシュし、キャッシュ優先で返す。/auth/ 以下は常にネットワークへ。
const VERSION = '2026-11-08.4'; // 受付アプリではビルドで埋め込む
const CACHE = `app-shell-${VERSION}`;
const SHELL = [
  '/',
  '/styles.css',
  '/app.js',
  '/manifest.webmanifest',
  '/vendor/jsQR.js',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(SHELL.map((url) => new Request(url, { cache: 'reload' })));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith('app-shell-') && key !== CACHE) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith('/auth/')) return;

  event.respondWith((async () => {
    // caches.open() はキャッシュがなければ作る。新しい版の activate が古いキャッシュを消した後に、
    // 古い版の Service Worker がまだ fetch を受けると、消したキャッシュを空で作り直してしまう
    // （iOS 26.3 のシミュレータで古い版のキャッシュ名が残った）。作らない caches.match() で引く。
    // ?login=... 付きで戻ってきたときもアプリシェルを返せるよう、クエリは無視して照合する
    const hit = await caches.match(req, { cacheName: CACHE, ignoreSearch: true });
    if (hit) return hit;
    try {
      return await fetch(req);
    } catch (e) {
      if (req.mode === 'navigate') {
        const shell = await caches.match('/', { cacheName: CACHE });
        if (shell) return shell;
      }
      throw e;
    }
  })());
});
```

要点は次のとおりである。

- 事前キャッシュでは `cache: 'reload'` を付けて取得し、HTTP キャッシュに残った古い版を取り込まないようにする
- `fetch` の処理では、キャッシュを `caches.open()` ではなく `caches.match(req, { cacheName })` で引く（10 章）
- クエリを無視して照合し、Discord から `/?login=...` 付きで戻ったときもアプリシェルを返す
- ネットワークに届かないページ遷移には、キャッシュした `/` を返す。Android エミュレータの機内モードでの起動は、この経路で表示された（8 章）
- このコードは `install` で `skipWaiting()`、`activate` で `clients.claim()` を呼び、新しい版を即時に有効化して古いキャッシュを消す。受付アプリでは、この点だけ意図的に変える。即時に有効化すると、再読み込みを停止中まで待たせる間、古いページと新しい版の Service Worker が組み合わさり、古いキャッシュにしかない資産をオフラインで取れなくなるためである。受付アプリの Service Worker は `install` で `skipWaiting()` を呼ばず、ページが停止中に待機中の版へ SKIP_WAITING のメッセージを送って有効化し、`controllerchange` で再読み込みする（Design Doc 6.11）。有効化と再読み込みが同時になるので、古い版が消したキャッシュを作り直す問題（10 章）も起きにくくなる

### 11.2 QR の読み取り

検証用の PWA は、カメラの映像を、長辺が 640px 以下になるよう縮めてキャンバスに描き、150ms ごとに jsQR 1.4.0 に渡した。jsQR には `inversionAttempts: 'dontInvert'` を指定し、白地に黒の QR だけを探させた。読み取った文字列が `fortee:` と英数字 32 文字の形式（`/^fortee:[A-Za-z0-9]{32}$/`）でなければ、判定には進まずバナーを出す（画面設計書 S03）。

検証用の PWA は映像の全体をデコードしたが、受付アプリでは、画面に出ている範囲だけを読み取る（画面設計書 S03）。そのため、表示している範囲を映像から切り出してからキャンバスに描く。

- 映像を `object-fit: cover` で領域に収める場合、表示の倍率は `max(領域の幅 / 映像の幅, 領域の高さ / 映像の高さ)` で、見えているのは、映像の中央を基準にした幅 `領域の幅 / 倍率`、高さ `領域の高さ / 倍率` の範囲である。この範囲を `drawImage` の切り出し元に指定する
- 長辺 640px の上限は、切り出した範囲に当てる。切り出した範囲は映像の全体より小さいので、同じ上限でも縮める割合が小さくなり、QR はより細かく描かれる。上限が適切かは、実カメラでの読み取りの確認（12 章）で決める

### 11.3 音を鳴らせる状態にする処理（iOS）

タップの処理の中で、`AudioContext` がなければ作り、`running` でなければ `resume()` を呼び、1 サンプルの無音を鳴らす。画面設計書 2.4 のとおり、音を鳴らしうる画面へ進むタップのたびにこれを行う。判定結果の音は、波形を計算して `AudioBuffer` に入れ、`AudioBufferSourceNode` で鳴らす。バッファは音の種類ごとに初回に作り、以後は使い回す。

## 12. 残る確認

- 実機（iOS 27）: 機内モードでの起動、1 回の起動の中でカメラを止めて再開したときに許可を求められるか（止めてから 1 分以上おいた場合を含む。4 章）と、再開してから映像が画面に出るまでの時間、カメラを拒否した後、バックグラウンドから戻った後の音、数日後のデータの保持
- iOS 26 の実機: すべての項目。カメラの許可は、シミュレータでは起動のたびに求められたので、特に確かめる
- Android の実機: すべての項目
- Discord ログインの残る条件（3.3）
- 実カメラでの QR の読み取りと、読み取りから判定表示までの時間（PRD の NFR-1）。どの端末でも、実カメラではテスト用 QR を読ませていない

## 13. 出典

- [Discord の apple-app-site-association（オリジン）](https://discord.com/.well-known/apple-app-site-association)、[同（Apple の CDN）](https://app-site-association.cdn-apple.com/a/v1/discord.com)
- [Maximiliano Firtman: iOS 12.2 の PWA についての記事](https://firt.dev/ios-12.2/)
- [Netguru: iOS のホーム画面 Web アプリと Safari の間で状態を共有する方法](https://www.netguru.com/blog/how-to-share-session-cookie-or-state-between-pwa-in-standalone-mode-and-safari-on-ios)
- [RFC 6749 §10.12 Cross-Site Request Forgery](https://www.rfc-editor.org/rfc/rfc6749#section-10.12)、[RFC 9700 Best Current Practice for OAuth 2.0 Security](https://www.rfc-editor.org/rfc/rfc9700)、[RFC 10027 Best Current Practice for Security of Cross-Device Flows（BCP 247）](https://www.rfc-editor.org/info/rfc10027)
- [WebKit Features in Safari 17.2](https://webkit.org/blog/14787/webkit-features-in-safari-17-2/)（ホーム画面に追加するときの Cookie の複写）
- WebKit の bug: [215884](https://bugs.webkit.org/show_bug.cgi?id=215884)、[327237](https://bugs.webkit.org/show_bug.cgi?id=327237)（ホーム画面アプリでのカメラの許可）
- [use-haptic](https://github.com/posaune0423/use-haptic)（iOS の switch の触覚を使う方法）と[その紹介記事](https://zenn.dev/posaune0423/articles/4f963b89ca2fdf)（コメント欄に iOS 26.5 以降の報告）
