// 端末の種類。OS ごとに文言を変えるところ（S01 のバナー、S03 の許可の手順）でだけ使う。
// iPadOS は Mac の UA を名乗るので、タッチの点数でも見る（services/platform.ts と同じ見方）

export const isIos = (): boolean =>
  /iPhone|iPad|iPod/.test(navigator.userAgent) ||
  (navigator.userAgent.includes("Macintosh") && navigator.maxTouchPoints > 1);

export const isAndroid = (): boolean => navigator.userAgent.includes("Android");

/** 端末で、動きを減らす設定をしているか（画面設計書 2.11） */
export const prefersReducedMotion = (): boolean => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
