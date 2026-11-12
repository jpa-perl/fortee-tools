// 書き出しの CSV（Design Doc 8.5）。RFC 4180 の引用で、カンマ、引用符、改行を含む値を引用符で囲む。
// 文字コードは UTF-8（BOM なし）、行の終わりは LF にする。

const NEEDS_QUOTE = /[",\r\n]/;
const FORMULA_START = /^[\p{White_Space}\p{Cc}\p{Cf}]*[=+\-@]/u;
const SIGNED_NUMBER = /^[+-](?:\d+(?:\.\d*)?|\.\d+)$/;

function field(value: string, format: "machine" | "spreadsheet"): string {
  // 判定時だけ正規化し、式になる値は引用したセルの先頭にタブを置く。数値の -900 はそのまま残す。
  const formula = format === "spreadsheet" && FORMULA_START.test(value.normalize("NFKC")) && !SIGNED_NUMBER.test(value);
  const text = formula ? `\t${value}` : value;
  return formula || NEEDS_QUOTE.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function toCsv(header: readonly string[], rows: readonly (readonly string[])[], format: "machine" | "spreadsheet"): string {
  return [header, ...rows].map((row) => `${row.map((value) => field(value, format)).join(",")}\n`).join("");
}
