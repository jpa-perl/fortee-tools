import { PNG } from "pngjs";

// ホーム画面のアイコン（manifest.webmanifest と apple-touch-icon）。素材の画像は置かず、ビルドのときに描く。
// 図形は、主ボタンの色（画面設計書 2.10 の青）の地に、白い丸とチェック。受付アプリの結果の帯の成功と同じ形である。
// 地を全面に塗り、図形を中央の 6 割に収めてあるので、丸く切り抜かれても（maskable）欠けない。
// 同じ入力からは、いつも同じ中身になる。中身が変わると、Service Worker のキャッシュの版が変わる

const GROUND = [0x1f, 0x4f, 0xa0] as const;
const MARK = [0xff, 0xff, 0xff] as const;

/** 点 (px, py) と、線分 (ax, ay)-(bx, by) の距離 */
function distanceToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** 図形までの距離。座標は、アイコンの 1 辺を 1 とした値。負なら図形の中 */
function distanceToMark(x: number, y: number): number {
  const half = 0.03;
  const ring = Math.abs(Math.hypot(x - 0.5, y - 0.5) - 0.27) - half;
  const check = Math.min(
    distanceToSegment(x, y, 0.385, 0.515, 0.465, 0.595),
    distanceToSegment(x, y, 0.465, 0.595, 0.62, 0.42),
  ) - half;
  return Math.min(ring, check);
}

/** 1 辺が size ピクセルの、正方形のアイコンの PNG */
export function appIconPng(size: number): Uint8Array {
  const png = new PNG({ width: size, height: size });
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      // 縁を、1 ピクセルの幅でなめらかにする
      const distance = distanceToMark((px + 0.5) / size, (py + 0.5) / size) * size;
      const mark = Math.max(0, Math.min(1, 0.5 - distance));
      const offset = (py * size + px) * 4;
      for (let channel = 0; channel < 3; channel++) {
        png.data[offset + channel] = Math.round((GROUND[channel] as number) * (1 - mark) + (MARK[channel] as number) * mark);
      }
      png.data[offset + 3] = 255;
    }
  }
  return new Uint8Array(PNG.sync.write(png));
}

/** 出力するアイコン。ファイル名と、1 辺のピクセル数 */
export const APP_ICONS = [
  { fileName: "icon-192.png", size: 192 },
  { fileName: "icon-512.png", size: 512 },
  // iOS のホーム画面のアイコン。iOS は manifest の icons を使わない
  { fileName: "apple-touch-icon.png", size: 180 },
] as const;
