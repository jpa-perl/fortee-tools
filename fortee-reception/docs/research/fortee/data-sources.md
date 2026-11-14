# 参加者データの取得経路

fortee から参加者データを取り出す経路は、参加者ごとの情報について 4 つ、チケット種別の設定について 1 つある。URL は [urls.md](urls.md)、識別子の意味は [data-model.md](data-model.md) を参照。

| 経路 | 得られるもの | 得られないもの |
| --- | --- | --- |
| ダウンロード ZIP | イベント単位。全参加者の CSV（チケット番号、ユーザ、チェックイン有無、チケットトークン入り URL、フォーム回答）と QR 画像（profile_url_token はここからデコード） | キャンセル済の参加者、参加者 ID、チェックイン日時、メール |
| 一覧の HTML 断片（bare-list） | 参加者 ID、チケット番号、種別、ユーザ、チェックイン有無、キャンセル済、他チケット、チケットトークン、「参加者一覧に表示する」を付けたフォーム回答 | profile_url_token、チェックイン日時、一覧表示にしていないフォーム回答 |
| 参加者一覧 API | フォーム項目設定で「API出力時のキー」を付けた項目と `avatar_url` | チケット番号、トークン、チェックイン状態、参加者 ID（他の経路と突合する鍵がない） |
| 参加者詳細画面 | 両トークン、チケット ID、チケット番号、ユーザ、メール、チェックイン日時、他チケット、フォーム回答すべて | （1 人ずつしか見られない） |
| イベント設定（チケット種別） | チケット種別 UUID、プレフィックス、価格、在庫、非表示・スポンサー用のフラグ、前提条件（チケット間の依存関係） | 参加者ごとの情報は含まない |

チケット種別の前提条件は参加者データのどの経路にも出ないので、イベント設定から読み取る（[data-model.md](data-model.md) の「チケット種別の前提条件」）。

## ダウンロード ZIP

「ダウンロード」画面（`/{conf}/organizer/attendees/download-data/{イベントID}`）で、ファイル名、デフォルトアイコン、出力フィールド（タブ区切りで列を指定、空欄で全列）、置換ルールを指定し、参加者タイプを選ぶか「すべてダウンロード」で ZIP を生成する。ファイル名は `{conf}-{文字列}-yyyymmdd-hhmmss.zip` になる。

ZIP はイベント単位で（テスト本編の ZIP には A 系の行だけ、テスト前夜祭の ZIP には M 系の行だけが入っていた）、CSV 1 本と、参加者ごとの QR 画像 2 枚（`qr-profile/`, `qr-feedback/`）、`avatar/` ディレクトリ（Sandbox ではアバター未設定のため空）が入る。キャンセル済の参加者は CSV にも画像にも含まれない。未発券の参加者は含まれ、User name と Issued が空の行になる（Sandbox で A-3 を未発券のまま採番して確認）。CSV に fortee の参加者 ID（UUID）とイベントの列はない。

取り込みに使う ZIP は、参加者タイプを絞らず「すべてダウンロード」で作る。取り込みはイベントのスナップショット全体を置き換える（Design Doc 8.3）ので、種別を絞った ZIP を取り込むと、そのイベントの参加者が絞った種別だけになる。CSV にイベントの列がないので、どのイベントの ZIP かは取り込みの指定（`import --event`）だけが根拠になり、別のイベントへ取り込んでも CSV からは検出できない。公開時の全イベントを通したチケットトークンの一意性の検証（Design Doc 8.4）で見つかるのは、同じ ZIP を 2 つのイベントに取り込んだ場合だけである。2 つのイベントの ZIP を入れ替えて取り込んだ場合は、トークンが一意のままなので見つからない。ZIP とイベントの対応は、ダウンロード画面のファイル名と、取り込んだチケット種別を管理者が確かめる（PRD 9 章）。

CSV は UTF-8（BOM 付き）で、列は次のとおり。

| 列 | 内容 |
| --- | --- |
| Ticket type | チケット種別名 |
| Ticket no | `A-1` |
| User name | fortee のハンドル名 |
| Issued | 発券日時 `2026/11/07 16:12` |
| Order, Order #, Ticket id | 空（外部チケット販売サイト連携用とみられる） |
| Avatar filename | `default-avatar.png` など |
| QR profile filename | `qr-profile-{種別名}-{チケット番号}.png` |
| QR feedback filename | `qr-feedback-{種別名}-{チケット番号}.png` |
| Name, Twitter, Serial code, Sponsor logo | 参加者（チケット）ごとの値（未設定なら空）。Name と Twitter は参加者詳細の「名前」「Twitter アカウント」欄に対応する（[data-model.md](data-model.md)） |
| checked_in | `true` / `false`。日時は含まれない |
| Ticket url | `https://fortee.jp/{conf}/attendee/{チケットトークン}` |
| （フォーム項目ごとの列） | Ticket url の後ろに、イベントのフォーム項目が「項目名」をそのまま列名として並ぶ（例: `お名前`, `所属`, `懇親会参加`）。ラジオボタンは選択肢のラベルが入る。未回答（その項目が対象外のチケット種別や、項目追加前の発券）は空 |

フォーム項目の列名は fortee 上の項目名そのものなので、項目名を変えると列名も変わる。「名前」タイプの項目を作っても `Name` 列には入らず、項目名の列に入った（Sandbox で確認）。`Name`・`Twitter` 列は fortee ユーザのプロフィールの値でもなく、参加者ごとの属性である（data-model.md の「参加者（チケット）」）。何がこの属性を埋めるかは未確認である。

チケット番号は、参加者のあいだで重複することがある。本番の本編（2026-11-13 の ZIP）で、同じ番号が別のユーザの 2 人に付いている組が 2 組あった。4 人ともキャンセル済みでも未発券でもなく、チケットトークンは別である。画像のファイル名は種別名とチケット番号から決まるので、同じ番号の 2 人は CSV の `QR profile filename` と `QR feedback filename` が同じ値になり、ZIP の画像は 1 枚しかない。その画像がどちらの参加者のものかは、ZIP からは分からない。採番は fortee が行い、主催者の側では直せない。重複した参加者の profile_url_token は、参加者詳細画面から読む。

QR 画像の内容は、`qr-profile/` が `https://fortee.jp/{conf}/attendee/{profile_url_token}/go-profile`、`qr-feedback/` が `https://fortee.jp/{conf}/attendee/{チケットトークン}` である（qrtool でデコードして確認）。profile_url_token を全参加者分そろえるには、この `qr-profile/` 画像を機械的にデコードするのが最も手間が少ない。

## 一覧の HTML 断片（bare-list）

管理画面の参加者一覧は、本体を XHR で `/{conf}/organizer/attendees/bare-list` から取得する。応答は JSON ではなく、参加者 1 人につき 1 つの `div.attendee.entity` を並べた HTML 断片で、要素には `data-uuid`（参加者 ID）と `data-event-uuid`（イベント ID）が付く。

| 情報 | 取り出し方 |
| --- | --- |
| チケット番号と参加者詳細 URL | `.badge a[href*="/organizer/attendees/view/"]`（最初のもの。テキストが `A-1` など） |
| チケット種別名 | チケット番号バッジの隣のテキスト |
| チェックイン済みか | チケット種別名の隣の `i.fa-user-check`。クラスが `text-success` なら済み、`text-secondary` なら未 |
| キャンセル済み | `div.badge.badge-light-danger` のテキスト「キャンセル済」 |
| 未発券 | チケット番号の隣の「未発行」 |
| ユーザ（ハンドル名） | `a.link-text` のテキスト。アバター画像が隣に付く |
| 当初支払価格 | `.key-value-inline` の「当初支払価格」 |
| フォーム回答（「参加者一覧に表示する」を付けた項目のみ） | `.key-value-inline` に項目名を `.key`、回答を `.value` として並ぶ（例: 所属） |
| 他チケット | 「他チケット」の `.value` 内に、他イベントのチケットがチケット番号バッジ・種別名・チェックインアイコン・キャンセル済バッジの同じ構造で並ぶ |
| チケットトークン | 右端の操作ボタンのうち `title="チケット"` のリンク `href="/{conf}/attendee/{チケットトークン}"` |

キャンセル・完全削除のフォーム（`delete/{参加者ID}`、`delete-completely/{参加者ID}`）も同じ断片に含まれる。表示中イベントの切り替えは `?event=`、絞り込みは `checkin_status=checked_in` / `not_checked_in`、検索フォームは同じ `index` に `q`、`r=1`（要レビューのみ）、`u=1`（未発券も表示）を付けて送る。未発券の参加者は `u=1` がないと一覧にも断片にも現れない。`bare-list` を直接呼ぶときに必要なリクエストヘッダは未確認である。

## 参加者一覧 API

イベント設定の「API有効」をオンにすると `/{conf}/api/attendees/api-list/{イベントID}` が有効になり、`{"attendees":[...]}` を返す。出力されるのはフォーム項目設定で「API出力時のキー」を設定した項目（キー名がそのまま JSON のキーになる）と `avatar_url` だけで、何も設定しなければ `avatar_url` しか出ない。チケット番号・トークン・参加者 ID・チェックイン状態は含まれないので、他の経路のデータと突合できず、公開用の参加者一覧（名前・所属など）の用途に限られる。

```json
{"attendees":[{"avatar_url":"https://fortee.jp/images/avatar-blank.png"},{"avatar_url":"https://fortee.jp/images/avatar-blank.png","name":"テスト 太郎","affiliation":"テスト株式会社","party":"参加する"}]}
```

## 参加者詳細画面

`/{conf}/organizer/attendees/view/{参加者ID}` には、参加者 ID、ユーザ、参加者タイプ、名前、Twitter、メール、登録・更新日時、チェックイン日時、他の参加者（同一ユーザの他チケット）、チケット ID、チケット番号、販売価格、フォーム、タグ、シリアルコード、スポンサー、フラグが載る。「QR」カードのリンクに両トークンが含まれる（FB タブ: `/attendee/{チケットトークン}`、プロフィールタブ: `/attendee/{profile_url_token}/go-profile`）。「フォーム」カードに回答がすべて表示され、更新履歴も見られる。「フォームサマリ・レビュー」画面（`form-summary?event=`）はラジオボタン・チェックボックス・セレクトボックスの選択肢ごとの集計だけで、個人の回答は出ない。
