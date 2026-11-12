// Service Worker とアプリの殻のキャッシュ（Design Doc 6.11）。
//
// まだないもの: 待機中の版を有効にする手順（SKIP_WAITING と controllerchange での再読み込み）、
// 1 時間ごとの更新の確認、キャッシュだけが失われたときの取り直し（PRECACHE）。
// 有効にする条件が画面の状態とロック（Design Doc 6.4、6.13）に依るので、それらとともに足す。

/** このビルドのキャッシュ名。ビルドが index.html に埋め込む。開発サーバでは空 */
function shellCacheName(): string {
  return document.querySelector<HTMLMetaElement>('meta[name="app-shell-cache"]')?.content ?? "";
}

/** 起動のたびに呼ぶ。登録があり、スクリプトの URL が同じなら、何もしない */
export function registerServiceWorker(): void {
  // 開発サーバは Service Worker を配らない
  if (shellCacheName() === "" || !("serviceWorker" in navigator)) return;
  void navigator.serviceWorker.register("/sw.js");
}

/**
 * オフラインで起動できるか。有効な Worker があり、かつ、このビルドのキャッシュに殻があるとき。
 * 有効な Worker があるだけでは足りない。登録が残ったままキャッシュだけが失われると、殻を返せない
 */
export async function isOfflineReady(): Promise<boolean> {
  const cacheName = shellCacheName();
  if (cacheName === "" || !("serviceWorker" in navigator)) return false;
  if (navigator.serviceWorker.controller === null) return false;
  // ページからも caches.open() は使わない。消されたキャッシュを空で作り直してしまう
  return (await caches.match("/", { cacheName, ignoreVary: true })) !== undefined;
}

/** 有効な Worker が替わったとき（初回のインストールで controller が付いたときを含む）に呼ばれる */
export function onControllerChange(listener: () => void): void {
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker.addEventListener("controllerchange", listener);
}
