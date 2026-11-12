// SQL の文に値を渡す方法（Design Doc 8.2）。
//
// wrangler の d1 execute には、値を束縛する手段がない。CLI が文に渡す値は、すべてこの 1 つの方法で渡す。
// 値を JSON にまとめ、その UTF-8 のバイト列を 16 進の BLOB リテラルで書き、文の中で文字列に戻す。
// 文に現れるのは 16 進の文字だけなので、値に引用符や改行が含まれていても文の構造は変わらない。
// 文字列リテラルへの埋め込みは、どの文でも行わない。

/** 値を JSON にして、SQL の式（JSON の文字列）にする。文の中では `->>` や json_each で取り出す */
export function jsonParam(value: unknown): string {
  const hex = Buffer.from(JSON.stringify(value), "utf8").toString("hex");
  return `CAST(x'${hex}' AS TEXT)`;
}

/**
 * 文字列を、そのままの値で SQL の式（文字列）にする。JSON に包まないので、文の中でそのまま比べたり入れたりできる。
 * 公開の版（meta.versions）のように、控えた文字列と 1 文字も違わない値を渡すときに使う（Design Doc 8.4）
 */
export function textParam(value: string): string {
  return `CAST(x'${Buffer.from(value, "utf8").toString("hex")}' AS TEXT)`;
}
