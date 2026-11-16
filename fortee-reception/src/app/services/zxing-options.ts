import type { ReaderOptions } from "zxing-wasm/reader";

// zxing-wasm に渡す読み取りの設定（Design Doc 6.8）。デコーダ（qr-decoder.ts）と、デコーダだけの計測
// （test/perf/）が同じ値を使うために、WASM を読み込まないファイルに分けて置く。

export const ZXING_READER_OPTIONS = {
  // QR だけを探す。ほかの形式の検出器を動かさない
  formats: ["QRCode"],
  // 白地に黒の QR だけを探す。反転した画像をもう一度調べない
  tryInvert: false,
  // 渡す画像は長辺 640 px 以下に縮めてある（scan-region.ts）。さらに縮めた画像を調べ直さない
  tryDownscale: false,
  // 複数の QR が写っていても、中央に最も近いものを選べる数だけ探す
  maxNumberOfSymbols: 4,
} satisfies ReaderOptions;
