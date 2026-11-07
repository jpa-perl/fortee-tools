# URL・エンドポイント早見表

`{conf}` はカンファレンスのスラッグ（本番 `yapc-tokyo-2026`、Sandbox `yapc-tokyo-2026-sandbox`）、`{event}` はイベントの UUID、`{attendee}` は参加者 ID（UUID）、`{ticket_type}` はチケット種別の UUID、`{staff}` はスタッフの UUID、`{ticket_token}` はチケットトークン、`{profile_token}` は profile_url_token である。識別子の意味は [data-model.md](data-model.md) を参照。

## 参加者向け

| 用途 | URL |
| --- | --- |
| チケットショップ | `/{conf}/ticket-shop/index`、イベント別 `/{conf}/ticket-shop/index/{event}` |
| チケット購入フォーム | `/{conf}/ticket-shop/{ticket_type}/form`（フォーム項目がなければ開いた時点で発券完了） |
| 自分のチケット一覧 | `/{conf}/me/ticket/list` |
| チケット詳細（QR 表示） | `/{conf}/attendee/{ticket_token}` |
| Apple ウォレット（.pkpass） | `/{conf}/attendee/{ticket_token}/apple-wallet` |
| Google ウォレット | `/{conf}/attendee/{ticket_token}/google-wallet`（Google の保存ページへリダイレクト） |
| プロフィール遷移 | `/{conf}/attendee/{profile_token}/go-profile` |

## 管理画面（オーガナイザ）

| 用途 | URL |
| --- | --- |
| 参加者一覧 | `/{conf}/organizer/attendees/index?event={event}`（絞り込み: `checkin_status=checked_in` / `not_checked_in`、検索 `q=`、`r=1` 要レビューのみ、`u=1` 未発券も表示） |
| 一覧本体（HTML 断片、XHR） | `/{conf}/organizer/attendees/bare-list` |
| 参加者詳細 | `/{conf}/organizer/attendees/view/{attendee}` |
| 手動チェックイン（フォーム POST） | `/{conf}/organizer/attendees/checkin-single/{attendee}`、解除 `.../checkin-single/{attendee}/cancel` |
| 参加者キャンセル（フォーム POST） | `/{conf}/organizer/attendees/delete/{attendee}` |
| 参加者完全削除（フォーム POST） | `/{conf}/organizer/attendees/delete-completely/{attendee}` |
| バルク追加（未発券の採番） | `/{conf}/organizer/attendees/add/{event}` |
| バルク削除 | `/{conf}/organizer/attendees/gc` |
| シリアルインポート | `/{conf}/organizer/attendees/import-serial` |
| ダウンロード（ZIP 生成画面） | `/{conf}/organizer/attendees/download-data/{event}` |
| QR 生成（画像の再生成） | `/{conf}/organizer/attendees/fetch-qrs?event={event}`、参加者単位 `.../fetch-qrs/{attendee}` |
| QR コード PDF 作成（POST `uuids[]`） | `/{conf}/organizer/attendees/create-qr-list-pdf` |
| チェックイン読み取り画面 | `/{conf}/organizer/attendees/checkin/{event}`（集計の絞り込み: `iu=true` 未発券を含む、`at=` 参加者タイプ UUID、`ttsg=` 在庫グループ UUID） |
| チェックイン状態取得 API | `GET /{conf}/organizer/attendees/api-get-check-in-status/{event}?code=...` |
| チェックイン状態更新 API | `POST /{conf}/organizer/attendees/api-set-check-in/{event}` |
| 一括チェックイン（CSV アップロード） | `/{conf}/organizer/attendees/bulk-checkin` |
| フォームサマリ | `/{conf}/organizer/attendees/form-summary?event={event}` |

## 設定

| 用途 | URL |
| --- | --- |
| イベント一覧 | `/{conf}/organizer/settings/events/index` |
| イベント詳細・編集 | `/{conf}/organizer/settings/events/view/{event}`、`.../edit/{event}` |
| チケット種別の追加・編集 | `/{conf}/organizer/settings/ticket-types/{event}/add`、`.../ticket-types/{event}/edit/{ticket_type}`（前提条件はここで確認） |
| チケット在庫グループの追加 | `/{conf}/organizer/settings/ticket-stock-groups/{event}/add` |
| フォーム項目 | `/{conf}/organizer/settings/event-form-fields/{event}/add`、`.../import` |
| アクセスコード | `/{conf}/organizer/settings/access-codes/{event}/index` |
| ウォレット拡張設定 | `/{conf}/organizer/settings/event-wallet-settings/{event}/index` |
| 参加者タイプ | `/{conf}/organizer/attendee-types/index` |
| スタッフ | `/{conf}/organizer/settings/staffs/index`、編集 `.../staffs/edit/{staff}` |

## 公開 API

| 用途 | URL |
| --- | --- |
| 参加者一覧 API（イベントの「API有効」が必要） | `/{conf}/api/attendees/api-list/{event}` |
| タグ一覧（管理画面が使用） | `/{conf}/api/tags/list` |
| Apple ウォレットの更新用 | `/{conf}/api/apple-wallet`（`.pkpass` の `webServiceURL`） |

## 公開 JS

| 画面 | ファイル |
| --- | --- |
| チェックイン読み取り画面 | `https://fortee.jp/build/page/conference-attendees.checkin.min.js`（jsQR と axios を同梱） |
| 参加者一覧 | `https://fortee.jp/build/page/conference-attendees.index.min.js` |
