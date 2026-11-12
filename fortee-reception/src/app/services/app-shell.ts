import type { AppShell } from "./ports.ts";

// Service Worker とアプリの殻のキャッシュ（Design Doc 6.11）。
//
// ここに置くのは、ブラウザの API の呼び出しだけである。待機中の版をいつ有効にするか、
// いつ再読み込みするかは、画面の状態とロックに依るので、操作（commands）が決める。

/** このビルドのキャッシュ名。ビルドが index.html に埋め込む。開発サーバでは空 */
function shellCacheName(): string {
  return document.querySelector<HTMLMetaElement>('meta[name="app-shell-cache"]')?.content ?? "";
}

const SW_URL = "/sw.js";

export function createAppShell(): AppShell {
  const supported = () => shellCacheName() !== "" && "serviceWorker" in navigator;
  const waitingListeners: (() => void)[] = [];
  const notifyWaiting = () => {
    for (const listener of waitingListeners) listener();
  };

  /**
   * 有効な Worker がないまま、インストール中の Worker が redundant になった（初回のインストールの失敗）。
   * register() のたびに戻す。waitActive() が、待たずに失敗とするのに使う
   */
  let installFailed = false;

  /** 登録を見張り、待機中の版が現れたら知らせる */
  function watch(registration: ServiceWorkerRegistration) {
    const check = () => {
      if (registration.waiting !== null && registration.active !== null) notifyWaiting();
    };
    const track = (worker: ServiceWorker | null) => {
      worker?.addEventListener("statechange", () => {
        if (worker.state === "redundant" && registration.active === null) installFailed = true;
        check();
      });
    };
    track(registration.installing);
    registration.addEventListener("updatefound", () => track(registration.installing));
    check();
  }

  function register() {
    if (!supported()) return;
    installFailed = false;
    navigator.serviceWorker.register(SW_URL).then(watch, () => {
      // 登録の失敗は、有効な Worker がないこととして、起動の待ち（Design Doc 6.4）で扱う
    });
  }

  const registration = async () => (supported() ? await navigator.serviceWorker.getRegistration() : undefined);

  return {
    enabled: supported,
    register,
    async hasActive() {
      return ((await registration())?.active ?? null) !== null;
    },
    waitActive(timeoutMs) {
      if (!supported()) return Promise.resolve(false);
      return new Promise<boolean>((resolve) => {
        let done = false;
        const finish = (ok: boolean) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          clearInterval(poll);
          resolve(ok);
        };
        // ready は、失敗しても拒否されずに保留のままになる
        const timer = setTimeout(() => finish(false), timeoutMs);
        // インストールに失敗した登録は捨てられる。有効な Worker もなく、インストール中の Worker が
        // redundant になったら、待たずに失敗とする。失敗は、Worker の状態の変化で知る（installFailed）。
        // インストールは 0.5 秒かからずに失敗することがあり、ここで登録を見るだけでは、インストール中の
        // 状態を見逃して、上限の時間まで待つことになる
        let sawInstalling = false;
        const poll = setInterval(() => {
          void registration().then((current) => {
            if (current?.active) return finish(true);
            if (current?.installing || current?.waiting) {
              sawInstalling = true;
              return;
            }
            if (sawInstalling || installFailed) finish(false);
          });
        }, 500);
        void navigator.serviceWorker.ready.then(() => finish(true));
      });
    },
    async hasWaiting() {
      const current = await registration();
      return current !== undefined && current.waiting !== null && current.active !== null;
    },
    async activateWaiting() {
      (await registration())?.waiting?.postMessage({ type: "SKIP_WAITING" });
    },
    update() {
      if (!supported()) return;
      void registration().then((current) => {
        if (current === undefined) register();
        else void current.update().catch(() => {});
      });
    },
    async isOfflineReady() {
      const cacheName = shellCacheName();
      if (cacheName === "" || !("serviceWorker" in navigator)) return false;
      if (navigator.serviceWorker.controller === null) return false;
      // ページからも caches.open() は使わない。消されたキャッシュを空で作り直してしまう
      return (await caches.match("/", { cacheName, ignoreVary: true })) !== undefined;
    },
    requestPrecache() {
      if (!supported()) return;
      navigator.serviceWorker.controller?.postMessage({ type: "PRECACHE" });
    },
    onWaiting(listener) {
      waitingListeners.push(listener);
    },
    onControllerChange(listener) {
      if (!("serviceWorker" in navigator)) return;
      let hadController = navigator.serviceWorker.controller !== null;
      navigator.serviceWorker.addEventListener("controllerchange", () => {
        const had = hadController;
        hadController = navigator.serviceWorker.controller !== null;
        listener(had);
      });
    },
    onPrecached(listener) {
      if (!("serviceWorker" in navigator)) return;
      navigator.serviceWorker.addEventListener("message", (event) => {
        if ((event.data as { type?: string } | null)?.type === "PRECACHED") listener();
      });
    },
  };
}
