// 読み取る範囲の計算（端末の挙動 11.2、画面設計書 S03）。DOM から切り離した関数にする（Design Doc 6.5）。
//
// 映像は object-fit: cover で上の領域に収める。読み取るのは、画面に出ている範囲だけである。

export type Rect = { x: number; y: number; width: number; height: number };
export type Size = { width: number; height: number };

/** デコーダに渡す画像の長辺の上限（Design Doc 6.5）。実カメラでの読み取りで決める調整値 */
export const DECODE_MAX_SIDE = 640;

/**
 * 映像のうち、領域に見えている範囲（映像の画素の座標）。
 * 表示の倍率は max(領域の幅 / 映像の幅, 領域の高さ / 映像の高さ) で、見えているのは、映像の中央を基準にした
 * 幅 領域の幅 / 倍率、高さ 領域の高さ / 倍率 の範囲である。大きさが決まっていなければ null
 */
export function visibleSourceRect(video: Size, box: Size): Rect | null {
  if (video.width <= 0 || video.height <= 0 || box.width <= 0 || box.height <= 0) return null;
  const scale = Math.max(box.width / video.width, box.height / video.height);
  const width = Math.min(video.width, box.width / scale);
  const height = Math.min(video.height, box.height / scale);
  return { x: (video.width - width) / 2, y: (video.height - height) / 2, width, height };
}

/** 切り出した範囲を、長辺が上限以下になるよう縮めた大きさ。拡大はしない */
export function decodeSize(source: Size, maxSide: number = DECODE_MAX_SIDE): Size {
  const ratio = Math.min(1, maxSide / Math.max(source.width, source.height));
  return {
    width: Math.max(1, Math.round(source.width * ratio)),
    height: Math.max(1, Math.round(source.height * ratio)),
  };
}

/** 映像の中で見つかった QR。四隅は、映像の画素の座標 */
export type DetectedCode = { text: string; corners: readonly { x: number; y: number }[] };

/**
 * 映像の全体から見つかった QR のうち、領域に見えている範囲（visibleSourceRect()）に四隅がすべて入っているものを
 * 1 つ選んで、その文字列を返す。なければ null。読み取るのは、画面に出ている範囲だけである（画面設計書 S03）。
 * 複数あれば、範囲の中央に最も近いものを選ぶ。スタッフは、読み取る QR を枠の中央に合わせるためである
 */
export function pickVisibleCode(codes: readonly DetectedCode[], visible: Rect): string | null {
  const centerX = visible.x + visible.width / 2;
  const centerY = visible.y + visible.height / 2;
  let best: { text: string; distance: number } | null = null;
  for (const code of codes) {
    if (code.text === "" || code.corners.length === 0) continue;
    const inside = code.corners.every(
      (corner) =>
        corner.x >= visible.x &&
        corner.x <= visible.x + visible.width &&
        corner.y >= visible.y &&
        corner.y <= visible.y + visible.height,
    );
    if (!inside) continue;
    const x = code.corners.reduce((sum, corner) => sum + corner.x, 0) / code.corners.length;
    const y = code.corners.reduce((sum, corner) => sum + corner.y, 0) / code.corners.length;
    const distance = (x - centerX) ** 2 + (y - centerY) ** 2;
    if (best === null || distance < best.distance) best = { text: code.text, distance };
  }
  return best?.text ?? null;
}
