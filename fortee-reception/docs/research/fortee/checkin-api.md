# チェックイン API

標準の読み取り画面が使う API は 2 つである。どちらもスタッフとしてログインしたセッション Cookie で呼べ、JSON ボディの POST を CSRF トークンなしで送っても 200 が返った。URL の一覧は [urls.md](urls.md) を参照。

| 用途 | メソッドとパス | パラメータ |
| --- | --- | --- |
| 状態取得 | `GET /{conf}/organizer/attendees/api-get-check-in-status/{イベントID}?code=...` | `code`: QR の文字列（`fortee:` 付き） |
| 状態更新 | `POST /{conf}/organizer/attendees/api-set-check-in/{イベントID}` | JSON `{"code": "...", "status": "used" \| "unused"}` |

## レスポンス

成功時:

```json
{"result":"OK","allowCheckIn":true,"checkInStatus":"unused","ticketNo":"M-1","ticketType":"テスト前夜祭チケット"}
```

失敗時は `{"result":"ERROR","errorMessage":"..."}` を返す。状態更新 API では失敗時も HTTP ステータスは 200 だった（状態取得 API のステータスは未確認）。成否は `result` で判定する必要がある。

| 状況 | errorMessage |
| --- | --- |
| `fortee:` なしの素のトークン、または存在しないトークン | チケットのバーコードではない様です |
| エンドポイントのイベントと別イベントのチケット | テスト前夜祭のチケットです（チケットが属するイベント名が入る） |
| キャンセル済のチケット | キャンセル済のチケットです |

`allowCheckIn` が `false` になる条件は再現できていない。標準 UI の JS は、この値が偽のとき「使用済にする」「未使用に戻す」の両ボタンを隠す。

## 状態更新の意味

- `used`: チェックイン済みにし、チェックイン日時を呼び出し時刻で記録する。既に `used` の参加者に再度送っても `OK` で `checkInStatus` は `used` のまま返る（Sandbox で確認）。再送で日時が更新されるかは未確認
- `unused`: チェックイン日時ごと消して「未チェックイン」に戻す
- 未発券の参加者も発券済みと同じに扱われる

## 標準 UI の挙動

JS から読み取り、Sandbox の API 応答で裏付けた。

1. QR を読み取ると状態取得 API を呼ぶ。
2. `allowCheckIn` が真かつ `checkInStatus` が `unused` なら、確認なしに即座に状態更新 API で `used` にする。
3. 既に `used` なら「未使用に戻す」ボタンだけを表示する。
4. エラーなら `errorMessage` を表示する。

読み取り画面はイベントごとに分かれ、右側に「1 時間ごとのチェックイン数」の集計表がある。集計はクエリ `iu`（未発券を含む）、`at`（参加者タイプ UUID）、`ttsg`（在庫グループ UUID）で絞り込める。

## 手動チェックイン

参加者詳細画面の「手動チェックイン」ボタンは `/{conf}/organizer/attendees/checkin-single/{参加者ID}` へのフォーム POST で、チェックイン済みの参加者では解除用の `.../cancel` に変わる。フォーム送信先の確認のみで、動作は未検証。

## 権限

fortee のスタッフロールは Admin、Master、Staff の 3 段階で、最も弱い Staff でも読み取り画面の表示と両 API の呼び出しができた（Sandbox で別アカウントを Staff にして確認）。スタッフでないユーザがどう扱われるかは未確認である。
