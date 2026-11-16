import qrcode from "qrcode-generator";

// テストと計測で使う、合成の QR。画面のテスト（qr-decoder.spec.ts）と、計測（test/perf/run.ts）が、同じ作り方を使う。

/** QR のモジュールの並び。true が暗いモジュール */
export type QrMatrix = boolean[][];

/** 文字列を、型番 6、誤り訂正 M の QR にする（41 x 41 モジュール） */
export function qrMatrix(text: string): QrMatrix {
  const code = qrcode(6, "M");
  code.addData(text);
  code.make();
  const count = code.getModuleCount();
  return Array.from({ length: count }, (_, row) => Array.from({ length: count }, (_, col) => code.isDark(row, col)));
}
