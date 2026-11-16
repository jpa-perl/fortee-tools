# zxing-wasm v3.1.7 の導入指針

この文書は、受付アプリの QR 読み取りに `zxing-wasm` v3.1.7 を採用すると決めた場合の手順と確認事項を記す。2026-11-16 に、この指針に沿って `zxing-wasm/reader` を直接使う経路で導入し、受付アプリの `jsQR` を置き換えた。利用できる端末ではブラウザの `BarcodeDetector` を使い、それ以外では `zxing-wasm` を使う。実装は [Design Doc](../design-doc.md) 6.8 にある。導入時の確認（末尾の章）のうち、1 と、2 の WebKit と同じ方法（キャンバスから得た `ImageData` をデコーダに渡す）の Chromium と WebKit での確認、5 は済んだ。2 の偽のカメラの映像からの読み取りは、画面のテストではなく、計測（`test/perf/run.ts` の cameraLoop を `--no-detector` で実行）で確かめた。3 のうち画面を通す確認と、4 の実機での比較は残っている。以下は、導入を決める前に書いた手順と確認事項である。採用の判断には、[フロントエンドの選定記録](frontend.md) 6、7 章に従い、実機での読み取りやすさと NFR-1 の計測結果を使う。

## 評価済みの範囲と残るリスク

v3.1.7 の npm 配布物について、プロジェクト外の一時ディレクトリで tarball の integrity とエントリを調べた。インストール時の lifecycle script は対象と依存パッケージになく、`npm audit signatures` は対象版の署名と provenance を検証した。provenance のソースコミットは [v3.1.7 のリリース](https://github.com/Sec-ant/zxing-wasm/releases/tag/v3.1.7)と一致した。`npm audit --omit=dev` が報告した既知の脆弱性は 0 件だった。

ネットワークなし、読み取り専用、権限とメモリを制限したコンテナでは、ローカルの WASM を指定した reader・writer・full の QR 生成と再読み取りが成功し、検査用の `fetch` フックに外部通信は記録されなかった。既定設定では reader の初期化時に `https://fastly.jsdelivr.net/npm/zxing-wasm@3.1.7/dist/reader/zxing_reader.wasm` への取得を試みた。これは[公式 README](https://github.com/Sec-ant/zxing-wasm/blob/v3.1.7/README.md#configuring-wasm-serving)の説明とも一致する。

更新した `codex` で Codex Security の Deep Scan を再実行し、配布物の 68 ファイルを対象とするレビューが完了した。中程度の指摘は 4 件である。各指摘と、この受付アプリでの到達条件は次のとおり。

| 指摘 | この受付アプリでの扱い |
| --- | --- |
| `ImageData` の幅・高さと RGBA バイト数の不一致を検査せず、WASM の読取関数へ渡す | `canvas.getImageData()` から得た値だけを渡す。接続部分でも幅・高さ、バイト数、640 px の上限を検査する。偽の `ImageData` 風オブジェクトを渡す経路を作らない |
| 画像のバイト入力と書き込みのバイト入力で、確保に使う `byteLength` とコピーに使う `length` が食い違うオブジェクトを受け付ける | 受付アプリでは `ImageData` の読取経路だけを使う。画像の符号化済みバイトを渡す経路と writer は導入しない。将来使う場合は、正規の `Uint8Array` に変換してからサイズを検査する |
| WeChat ミニプログラム向け Blob 代替実装が、部分配列の範囲外のバイトを返しうる | 受付アプリはミニプログラム向けの出力を読み込まない。別の製品で使う場合には、個別の対策が要る |
| 既定の CDN から取得した WASM を、公開されている SHA-256 と照合せずに実行する | reader 用 WASM を同じオリジンから配り、既定の取得先を初期化時に上書きする。Service Worker の事前キャッシュで配信内容の SHA-256 を照合し、オフラインの初回読み取りを試す |

最初の指摘は JavaScript 側のサイズ不一致まで確認されたが、WASM 内部で範囲外の読み取りが起きるかは確定していない。配布物のファイル一覧についてはレビューを完了した一方、3 つの WASM バイナリの内部は構造的な調査にとどまる。元の C++ ソース、実際の配信先、受付アプリへの組み込みは Deep Scan の対象外である。WASM の再現ビルドと網羅的なファジングも行っていないため、未知の脆弱性や、細工された画像による処理停止は否定できない。

## 採用する経路の決定

現行の `QrDecoder` は `ImageData` から同期的に文字列を返す。一方、`zxing-wasm` の `readBarcodes` は `Promise<ReadResult[]>` を返す。[公式 API](https://sec-ant.github.io/zxing-wasm/docs/functions/reader.readBarcodes.html) この差を埋める方法を決めてから実装する。

| 経路 | 変更する箇所 | 判断の材料 |
| --- | --- | --- |
| `zxing-wasm/reader` を直接使う | `QrDecoder` と `camera.ts` のキャンバス経路を非同期にする | QR の読み取りに必要なパッケージだけで済む。進行中の読み取り、停止後に届く結果、重複した結果を管理する必要がある |
| `barcode-detector` を介して使う | 既存の非同期 `FrameDetector` 経路に合わせる | カメラとの接続を変える範囲を抑えやすい。ただし別の依存パッケージとその配布物・WASM 読み込み設定を追加で評価する必要がある |

依存関係を増やさずに評価済みの配布物を使うなら、直接 `zxing-wasm/reader` を呼ぶ方法を先に検討する。ただし、これは現行の [Design Doc](../design-doc.md) 6.8 が記す同期の継ぎ目を変更するため、採用を決めた時点で設計も更新する。どちらの経路でも、ブラウザの `BarcodeDetector` が使えない端末で、オフラインの初回読み取りが成立することを確かめる。

## 配布物の固定と WASM の同梱

採用を決めたら、`fortee-reception/` で `npm install --save-exact zxing-wasm@3.1.7` を実行し、`package.json` と `package-lock.json` の差分を確認する。既存依存の意図しない更新がないことを見た上で、`npm ci`、`npm audit signatures`、`npm audit --omit=dev` を実行する。`--save-exact` は `package.json` に範囲指定を付けないための指定である。[npm install の説明](https://docs.npmjs.com/cli/install/) `npm audit signatures` は署名と provenance の検証を行う。[npm の説明](https://docs.npmjs.com/viewing-package-provenance/) 既知の脆弱性が 0 件でも、入力処理の安全性が証明されたことにはならない。

受付アプリには `zxing-wasm/reader` と同じ版の `zxing_reader.wasm` だけを組み込む。v3.1.7 の reader WASM の SHA-256 は `33c8c50be17d0bb05454b4fd3ffb5b5ab9a8e8d1c0ebeb21a1adf4a89c1a8b59` である。パッケージが公開する `ZXING_WASM_SHA256` と、ビルドに使うファイルのハッシュが一致することを確認する。版を上げるときは JS と WASM を一緒に更新する。[公式 README](https://github.com/Sec-ant/zxing-wasm/blob/v3.1.7/README.md#configuring-wasm-serving)

Vite 8.3.5 と v3.1.7 を使った隔離した最小ビルドでは、次の `?url` import で約 947 kB の WASM がハッシュ付きの別ファイルとして出力された。Vite は `?url` をアセットの URL として扱う。[Vite の説明](https://vite.dev/guide/assets)

```ts
import { prepareZXingModule, readBarcodes } from "zxing-wasm/reader";
import readerWasmUrl from "zxing-wasm/reader/zxing_reader.wasm?url";

// 最初の readBarcodes() より前に、受付アプリの初期化で一度だけ呼ぶ。
prepareZXingModule({
  overrides: {
    locateFile(path: string, prefix: string) {
      if (path === "zxing_reader.wasm") return readerWasmUrl;
      if (path.endsWith(".wasm")) throw new Error(`想定外の WASM: ${path}`);
      return prefix + path;
    },
  },
});

// 読み取り側の例。結果の受理は camera.ts の停止・世代管理に従う。
export async function decodeQr(imageData: ImageData): Promise<string | null> {
  const { width, height, data } = imageData;
  if (
    !Number.isSafeInteger(width) || !Number.isSafeInteger(height) ||
    width < 1 || height < 1 || width > 640 || height > 640 ||
    !(data instanceof Uint8ClampedArray) || data.byteLength !== width * height * 4
  ) throw new RangeError("不正な QR 画像の大きさ");
  const results = await readBarcodes(imageData, { formats: ["QRCode"] });
  return results[0]?.text ?? null;
}
```

`prepareZXingModule` を呼ばない場合、ライブラリは既定の CDN URL を使う。コード例を採用するときも、本番ビルドの WASM URL が同じオリジンであることを検査する。`build/app-shell.ts` は受付アプリのビルド出力を列挙して Service Worker の事前キャッシュに含める設計なので、WASM がその一覧に入り、ハッシュ照合を通ることをビルドと画面のテストで確かめる。これが欠けると、オフラインでアプリを開けても QR を読み取れない。

## 読み取り処理の条件

直接呼び出す場合、`camera.ts` の 150 ms 間隔の処理は、前の `readBarcodes` が終わるまで次のコマを渡さない。`pauseDecoding()`、`stop()`、新しい `start()` の後に届いた結果は捨てる。例外は読み取り失敗として扱い、次のコマを試せる状態に戻す。現行の `FrameDetector` 経路が持つ進行中フラグと世代の扱いが参考になる。WASM の取得や初期化に失敗した場合も CDN へ切り替えず、`jsQR` を残して使うか読み取り失敗として案内するかを実装前に決める。ただし、Promise を返すことだけではデコード中のメインスレッドの停止は防げないため、実機の計測で応答性も確認する。

入力には、画面に見える範囲を切り出し、長辺を 640 px 以下にした、ブラウザの `canvas.getImageData()` が返す `ImageData` だけを渡す。コード例の 640 は説明のための値で、実装では `scan-region.ts` の `DECODE_MAX_SIDE` を参照する。`formats: ["QRCode"]` で対象形式を絞り、読み取った文字列は現行どおり `/^fortee:[A-Za-z0-9]{32}$/` で検証してから判定へ進める。QR の内容は信頼できる入力ではなく、文字列の形式検証はデコーダが細工された画像を処理する際の脆弱性への対策にはならない。CLI のプロフィール QR 読み取りも `jsQR` を使っているため、受付アプリだけを切り替える段階で `jsQR` の依存関係を削除しない。

## 導入時の確認

1. 本番相当のビルドに reader 用 WASM が 1 ファイル出力され、`full` と `writer` の WASM が混入していないことを確認する。Service Worker の事前キャッシュ一覧にも、その reader 用 WASM と SHA-256 が含まれることを確認する。
2. Chromium では偽のカメラの映像から、オンラインの準備後にオフラインへ切り替えて最初の QR 読み取りを通す。画面テストの WebKit はカメラを開始できないため、ブラウザのキャンバスから得た `ImageData` をデコーダに渡してオフラインでの WASM 読み込みと読み取りを確かめる。いずれも CDN への要求がないことを通信ログで確認する。既存の画面テストの QR 文字列を直接渡す入口だけでは、デコーダと WASM の読み込みを検証できない。
3. QR なし、複数の QR、読めない画像、停止直後に届く結果、連続した同一 QR を試し、判定と記録が重複しないことを確認する。
4. iOS と Android の実機で、画面とウォレットの QR の読み取りやすさ、NFR-1、メインスレッドの応答性を現行実装と比較する。`test/perf/` のデコーダ専用計測は `jsQR` を直接呼んでいるため、比較の際は同じ入力・条件で測れるように更新する。
5. 採用結果に応じて [Design Doc](../design-doc.md) 6.8・14 章、[フロントエンドの選定記録](frontend.md) 6・8 章を更新する。新しい版への更新でも、配布物の署名、差分、WASM のハッシュ、オフライン読み取りを再確認する。
