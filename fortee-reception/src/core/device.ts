// 端末名（Design Doc 9.1）。端末 ID から決定的に導く、「端末 7F3K」のような短い名前。
// 記録には持たず、画面（S08、S09）と書き出しが、記録の端末 ID から同じ規則で出す。

/** 見間違えやすい文字（0 と O、1 と I）を除いた 32 文字 */
const ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

/** 端末 ID（UUID）の先頭の 20 ビットを、5 ビットずつ 4 文字にした符号（「7F3K」の部分） */
export function deviceCode(deviceId: string): string {
  // 先頭の 16 進 5 桁が 20 ビットにあたる。UUID の形は、境界で検証済みである
  const bits = Number.parseInt(deviceId.slice(0, 5), 16);
  let code = "";
  for (let shift = 15; shift >= 0; shift -= 5) code += ALPHABET[(bits >> shift) & 0x1f];
  return code;
}

/** 端末名。「端末 7F3K」 */
export function deviceName(deviceId: string): string {
  return `端末 ${deviceCode(deviceId)}`;
}
