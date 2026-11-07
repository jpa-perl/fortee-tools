# チェックイン用 QR コード

## 内容

参加者に表示される QR コードの内容は、`fortee:` にチケットトークンを続けた 39 文字の文字列である。

```
fortee:aRZAnjQt1sepvZ2OTJLNQZ1MsAI93cAw
```

チケットトークンは [data-model.md](data-model.md) の「2 種類のトークン」を参照。M-1 の QR を Chrome の BarcodeDetector で読み取って形式を確かめ、A-1 についても同じ形式の文字列をチェックイン状態取得 API に渡して `A-1` が返ることを確認した。

## 表示場所

同じ内容の QR が次の場所に現れる。いずれも検証済み。

| 場所 | 形式 |
| --- | --- |
| 参加者メニュー「チケット」一覧（`/{conf}/me/ticket/list`）と各チケットの詳細（`/{conf}/attendee/{チケットトークン}`） | `<img>` で埋め込まれた画像 |
| Apple ウォレット（`.pkpass`） | `pass.json` の `barcode.message`（`format` は `PKBarcodeFormatQR`）。`serialNumber` は参加者 ID、`webServiceURL` は `/{conf}/api/apple-wallet` |
| Google ウォレット | 保存ページ URL 内の JWT の `eventTicketObjects[].barcode.value`（`type` は `QR_CODE`）。オブジェクト ID は発行者 ID + 参加者 ID、クラス ID は発行者 ID + `fortee.` + イベント ID |

## チェックイン用ではない QR

fortee は同じ参加者に対して別の QR も生成する。読み取り結果が URL なら、これらのどれかである。

| QR | 内容 | 現れる場所 |
| --- | --- | --- |
| フィードバック QR | `https://fortee.jp/{conf}/attendee/{チケットトークン}` | 参加者詳細の「QR → FB」タブ、ダウンロード ZIP の `qr-feedback/` |
| プロフィール QR | `https://fortee.jp/{conf}/attendee/{profile_url_token}/go-profile` | 参加者詳細の「QR → プロフィール」タブ、ダウンロード ZIP の `qr-profile/`、「QRコードPDF作成」の PDF |

「QRコードPDF作成」の PDF は、参加者一覧で表示中の参加者 ID を `uuids[]` として POST して作られ、1 人 1 ブロックでチケット種別・チケット番号・アバター・ユーザ名とプロフィール QR を印字し、QR の下に profile_url_token を文字列で印字する。名札用途とみられる。

## 標準の読み取り画面の処理

読み取り画面（`/{conf}/organizer/attendees/checkin/{イベントID}`）は、ブラウザのカメラ映像（背面カメラ、240×320）を 300ms ごとに jsQR でデコードし、得られた文字列をそのまま `code` としてチェックイン API に渡す。文字列の加工や検証は行わない。API の挙動は [checkin-api.md](checkin-api.md) を参照。
