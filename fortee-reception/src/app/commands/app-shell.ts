import { offlineReady } from "../state/app-shell.ts";
import { midOperation } from "../state/derived.ts";
import { overlay, screen, storagePersisted, updateWaiting } from "../state/model.ts";
import { abortSync, distributionQueued, flushHeldDistribution, syncBusy } from "./sync.ts";
import { refreshReception } from "./reception.ts";
import { closeDatabase, queueIdle, rt } from "./runtime.ts";

// Service Worker の更新と、再読み込み（Design Doc 6.11、6.13）。IndexedDB の versionchange を受けたときの
// 再読み込み（Design Doc 6.3）も、同じ扱いにする。

/** registration.update() の間隔（Design Doc 6.13 の調整値） */
const UPDATE_INTERVAL_MS = 60 * 60_000;
/** S99 の「再読み込み」で、待機中の版が有効になるのを待つ時間。超えたら、そのまま読み込み直す */
const ACTIVATE_WAIT_MS = 3000;

/** 再読み込みが要る（controllerchange か versionchange を受けた）。受付操作の途中が終わるまで延ばす */
let reloadPending = false;
/** versionchange を受けた。列が空になってから、接続を閉じて再読み込みする */
let closePending = false;
let reloading = false;
let lastUpdateCheckAt = 0;
/** S01 の初回の取得が進行中か。待機中の版を有効にしない */
let preparing = false;

export function setPreparing(value: boolean): void {
  preparing = value;
  if (!value) rt.settle();
}

/** オフラインで起動できるかを判定し直す（Design Doc 6.11）。起動時と、S09 を開いたときに呼ぶ */
export async function refreshOfflineReady(): Promise<void> {
  offlineReady.value = await rt.ports.appShell.isOfflineReady();
}

/** 記憶域の永続化が認められているかを判定し直す。S09 を開いたときに呼ぶ */
export async function refreshStoragePersisted(): Promise<void> {
  storagePersisted.value = await rt.ports.platform.persisted();
}

function reloadNow(): void {
  if (reloading) return;
  reloading = true;
  // 進行中の同期と取得は、待たずに中断する。確定していないトランザクションは破棄される
  abortSync();
  closeDatabase();
  rt.ports.platform.reload();
}

/** 再読み込みが要るなら、受付操作の途中でなければ行う。versionchange の後は、列が空になるのも待つ */
function maybeReload(): void {
  if (!reloadPending && !closePending) return;
  if (screen.value.id !== "S99") {
    if (midOperation.value) return;
    if (closePending && !reloadPending && !queueIdle()) return;
  }
  reloadNow();
}

/** 待機中の版を有効にしてよいか（Design Doc 6.11 の表）。どの画面でも、ロックを持つ画面だけが有効にする */
async function canActivate(): Promise<boolean> {
  const current = screen.value;
  if (current.id === "S99") {
    if (rt.releaseLock !== null) return true;
    // 列が空になるのは待たない。ロックを取れるなら、ほかに動いている画面はない
    const release = await rt.ports.locks.acquire();
    if (release === null) return false;
    rt.releaseLock = release;
    return true;
  }
  if (rt.releaseLock === null || !queueIdle() || syncBusy() || preparing) return false;
  if (current.id === "home") return current.mode.kind === "idle" && overlay.value === null;
  if (current.id === "S01") return current.phase === "fetchFailed" || current.phase === "needsLogin";
  return false;
}

let activating = false;

/** 待機中の版があり、条件を満たせば、有効にする。有効になると controllerchange が届き、再読み込みする */
async function maybeActivate(): Promise<void> {
  if (!updateWaiting.value || activating || reloading) return;
  activating = true;
  try {
    // 操作の途中で一瞬だけ通る状態（結果から読み取り中へ移るときの停止中）では、有効にしない。
    // いまの操作が終わってから、条件を見る
    await Promise.resolve();
    if (await canActivate()) await rt.ports.appShell.activateWaiting();
  } finally {
    activating = false;
  }
}

/** 受付操作の途中が終わったとき、列が空になったとき、同期が終わったときに、保留していたことを反映する */
export function settle(): void {
  if (!rt.failed && !midOperation.value) {
    // 配布物の差し替えは、受付の計算し直しも行い、知らせを 2 行に並べて同時に出す
    if (!flushHeldDistribution() && !distributionQueued()) refreshReception();
  }
  maybeReload();
  void maybeActivate();
}

/** S01 と S99 に入ったときに、1 時間ごとの確認を待たずに新しい版を探す */
export function checkForUpdate(): void {
  lastUpdateCheckAt = rt.ports.platform.now();
  rt.ports.appShell.update();
}

/** 1 秒ごとに呼ぶ。一日中開いたままの端末にも、その日のうちに新しい版が届くようにする */
export function appShellTick(time: number): void {
  if (time - lastUpdateCheckAt >= UPDATE_INTERVAL_MS) checkForUpdate();
}

/** IndexedDB の versionchange を受けた。その場では接続を閉じない（Design Doc 6.3） */
export function onDatabaseBlocking(): void {
  closePending = true;
  maybeReload();
}

/** 起動のたびに Service Worker を登録し、更新と取り直しの通知を受け取り始める */
export function startAppShell(): void {
  const { appShell, platform } = rt.ports;
  lastUpdateCheckAt = platform.now();
  appShell.onWaiting(() => {
    updateWaiting.value = true;
    void maybeActivate();
  });
  appShell.onControllerChange((hadController) => {
    if (!hadController) {
      // 初回のインストールで controller が付いた。再読み込みはしない。S01 を読み込み直さないためである
      void refreshOfflineReady();
      return;
    }
    reloadPending = true;
    maybeReload();
  });
  appShell.onPrecached(() => void refreshOfflineReady());
  appShell.register();
  void (async () => {
    await refreshOfflineReady();
    // 登録が残ったままキャッシュだけが失われていたら、有効な Service Worker に取り直しを求める。
    // controller のない端末は、register() の再インストールに任せる
    if (offlineReady.value === false && platform.online() && (await appShell.hasActive())) appShell.requestPrecache();
  })();
}

/**
 * S99 の「再読み込み」。待機中の版があって条件を満たせば、有効にしてから読み込み直す。
 * ふつうの再読み込みでは、待機中の版が有効にならないことがある（Design Doc 6.11）
 */
export async function reloadFromError(): Promise<void> {
  if (await rt.ports.appShell.hasWaiting()) {
    if (await canActivate()) {
      await rt.ports.appShell.activateWaiting();
      // controllerchange で再読み込みする。届かなければ、そのまま読み込み直す
      rt.ports.platform.after(ACTIVATE_WAIT_MS, reloadNow);
      return;
    }
  }
  reloadNow();
}

/** S00 の「再読み込み」。更新の待機で止めた印を消してから、起動をやり直す（Design Doc 6.4 の 2） */
export function reloadFromGuide(): void {
  rt.ports.platform.setBlockedFlag(false);
  reloadNow();
}
