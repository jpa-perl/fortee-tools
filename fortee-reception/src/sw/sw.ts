// Service Worker（Design Doc 6.11、端末の挙動 11.1）。
// アプリの殻を事前にキャッシュし、キャッシュ優先で返す。スナップショットと記録は扱わない（IndexedDB に置く）。
//
// 守ること:
// - 事前にキャッシュするときに HTTP キャッシュを通さない（cache: "reload"）
// - 事前にキャッシュする中身が、このビルドの出力と同じであることを、ハッシュで確かめる。取得の途中で
//   配信が別の版に切り替わると、この版の JavaScript と、別の版の HTML がそろうことがある。
//   取得の成功だけで有効にすると、キャッシュした HTML が、キャッシュにない JavaScript を指す
// - 要求に答えるときは、キャッシュを caches.open() ではなく caches.match(req, { cacheName }) で引く。
//   新しい版が消したキャッシュを、まだ動いている古い版が空で作り直すのを防ぐ（端末の挙動 10 章）
// - クエリを無視して照合する。Discord から /?login=... 付きで戻ったときも殻を返す
// - Vary を無視して照合する。殻のファイルは URL だけで決まる。応答に Vary: Origin が付いていると、
//   crossorigin 属性の付いた script と link の要求（Origin を伴う）が、事前にキャッシュした応答と合わず、
//   オフラインで JS と CSS を返せない
// - ネットワークに届かないページ遷移には、キャッシュした「/」を返す
// - /api/ と /auth/ 以下と、別のオリジンへの要求は扱わない
// - install では skipWaiting() を呼ばない。ページが SKIP_WAITING を送ったときに有効になり、
//   ページは controllerchange で再読み込みする。有効化と再読み込みを同時にするためである
//
// このファイルは、ほかのファイルを読み込まない。一覧と版は、ビルドが埋め込む（build/app-shell.ts）。

// WebWorker の型では self が WorkerGlobalScope なので、Service Worker の型で受け直す
const sw = self as unknown as ServiceWorkerGlobalScope;

/** ビルドが、版と、事前にキャッシュするファイルの一覧（URL と、配信される中身の SHA-256）に置き換える */
declare const __PRECACHE_MANIFEST__: { version: string; files: { url: string; sha256: string }[] };
const MANIFEST = __PRECACHE_MANIFEST__;

/** build/app-shell.ts の値と同じにする */
const CACHE_PREFIX = "app-shell-";
const CACHE = `${CACHE_PREFIX}${MANIFEST.version}`;

/** ページから受け取るメッセージ */
type ClientMessage = { type: "SKIP_WAITING" } | { type: "PRECACHE" };
/** ページへ送るメッセージ。PRECACHE で殻を取り直し終えたことを知らせる */
const PRECACHED = { type: "PRECACHED" } as const;

async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * 殻のファイルをすべて取得し、どれもこのビルドの中身であることを確かめてから、キャッシュに入れる。
 * 1 つでも取得できないか、中身が違えば、何も入れずに失敗する
 */
async function precache(): Promise<void> {
  const responses = await Promise.all(
    MANIFEST.files.map(async ({ url, sha256 }) => {
      const response = await fetch(new Request(url, { cache: "reload" }));
      if (!response.ok) throw new Error(`precache: ${url} を取得できない（${response.status}）`);
      if ((await sha256Hex(await response.clone().arrayBuffer())) !== sha256) {
        throw new Error(`precache: ${url} の中身が、このビルドのものと違う`);
      }
      return { url, response };
    }),
  );
  const cache = await caches.open(CACHE);
  await Promise.all(responses.map(({ url, response }) => cache.put(url, response)));
}

sw.addEventListener("install", (event) => {
  // 1 つでも取得に失敗するか、中身が違えば、この版は有効にならず、古い版のまま動き続ける
  event.waitUntil(precache());
});

sw.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) {
        if (key.startsWith(CACHE_PREFIX) && key !== CACHE) await caches.delete(key);
      }
      await sw.clients.claim();
    })(),
  );
});

sw.addEventListener("message", (event) => {
  const message = event.data as ClientMessage | undefined;
  if (message?.type === "SKIP_WAITING") {
    event.waitUntil(sw.skipWaiting());
    return;
  }
  if (message?.type === "PRECACHE") {
    // 登録が残ったままキャッシュだけが失われたときに、ページが殻の取り直しを求める。
    // 待機中の版に置き換えられて有効な Worker でなくなっていれば、無視する。
    // 新しい版が消したキャッシュを、古い版が作り直さないためである
    // ServiceWorkerGlobalScope.serviceWorker のないブラウザでは、状態を確かめられないので、そのまま進む
    const state = (sw as { serviceWorker?: ServiceWorker }).serviceWorker?.state;
    if (state !== undefined && state !== "activated") return;
    const source = event.source;
    event.waitUntil(
      (async () => {
        await precache();
        source?.postMessage(PRECACHED);
      })(),
    );
  }
});

sw.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== sw.location.origin) return;
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/auth/")) return;

  event.respondWith(
    (async () => {
      const hit = await caches.match(request, { cacheName: CACHE, ignoreSearch: true, ignoreVary: true });
      if (hit !== undefined) return hit;
      try {
        return await fetch(request);
      } catch (error) {
        if (request.mode === "navigate") {
          const shell = await caches.match("/", { cacheName: CACHE, ignoreVary: true });
          if (shell !== undefined) return shell;
        }
        throw error;
      }
    })(),
  );
});
