import type { RecordOperator } from "../../core/records.ts";
import type { Ports } from "../services/ports.ts";
import { midOperation } from "../state/derived.ts";
import {
  browserTab,
  busy,
  canVibrate,
  config,
  confirmedReception,
  cursor,
  deviceId,
  judging,
  lastSyncAt,
  lastSyncFailed,
  needsLogin,
  notice,
  now,
  online,
  operator,
  overlay,
  override,
  records,
  type Screen,
  screen,
  snapshots,
  soundEnabled,
  syncInFlight,
  vibrationEnabled,
} from "../state/model.ts";
import { clearForLogout, openDatabase, readData, readMeta, writeMeta } from "../storage/db.ts";
import {
  appShellTick,
  checkForUpdate,
  onDatabaseBlocking,
  setPreparing,
  settle,
  startAppShell,
} from "./app-shell.ts";
import { handleBack } from "./navigation.ts";
import { initReception, refreshReception } from "./reception.ts";
import { enqueue, fatal, go, rt, setOverlay } from "./runtime.ts";
import { onHidden, scanTick } from "./scan.ts";
import { abortSync, deferNextSync, distributionQueued, resetSync, runSync, syncTick } from "./sync.ts";

// 起動、ログイン、ログイン後の初期取得、ログアウト（Design Doc 6.4）。

/** Service Worker の有効化の待ち（Design Doc 6.13 の調整値） */
const APP_SHELL_WAIT_MS = 60_000;

export type BootOptions = {
  /** テストで版上げの重なりを起こすためのもの。ふつうは省く */
  databaseVersion?: number;
  openTimeoutMs?: number;
};

let bootOptions: BootOptions = {};
let stopTicker: (() => void) | null = null;
let listening = false;

/** 1 秒ごとの処理。現在時刻の更新、受付の計算し直し、定期の同期、読み取りの 2 分、更新の確認 */
export function tick(): void {
  if (rt.failed) return;
  const time = rt.ports.platform.now();
  now.value = time;
  appShellTick(time);
  // ログイン済みで、ホームに着いた後だけ
  if (rt.db === null || rt.releaseLock === null || stopTicker === null) return;
  if (!distributionQueued()) refreshReception();
  scanTick(time);
  syncTick(time);
}

function stopSchedule(): void {
  stopTicker?.();
  stopTicker = null;
}

function closeDatabase(): void {
  rt.db?.close();
  rt.db = null;
}

/**
 * 起動する（Design Doc 6.4）。main.tsx が、描画の後に 1 回だけ呼ぶ。
 * ports は、ブラウザの実装（services/browser.ts の createBrowserPorts()）を渡す。テストは偽物を渡す
 */
export async function boot(ports: Ports, options: BootOptions = {}): Promise<void> {
  rt.ports = ports;
  bootOptions = options;
  rt.settle = settle;
  rt.halt = () => {
    stopSchedule();
    abortSync();
    // 直した版で起動し直せるように、新しい版を探す（Design Doc 6.11）
    checkForUpdate();
  };
  const { platform } = ports;
  now.value = platform.now();
  online.value = platform.online();
  browserTab.value = platform.isBrowserTab();
  canVibrate.value = ports.feedback.canVibrate();

  if (!listening) {
    listening = true;
    platform.onOnlineChange((value) => {
      online.value = value;
      // オンラインを検知したら、自動で同期する（FR-40）
      if (value && stopTicker !== null) void runSync();
    });
    platform.onVisibilityChange((visible) => {
      if (!visible) onHidden();
    });
    ports.historyGuard.init(handleBack);
    startAppShell();
  }

  try {
    await start();
  } catch (error) {
    fatal(error);
  }
}

/** 起動の手順 1〜5（Design Doc 6.4）。再ログインに失敗した後の「戻る」でも、ここからやり直す */
async function start(): Promise<void> {
  const { platform, locks } = rt.ports;

  // 1. iOS で、Safari のタブで開いている（NFR-8）
  if (platform.isIosSafariTab()) return go({ id: "S00", reason: "safariTab" });

  // 2. 更新の待機で止めた印があるか、ほかの画面がロックを持っていれば、IndexedDB を開かない
  if (platform.blockedFlag() || (await locks.isHeld())) return go({ id: "S00", reason: "otherInstance" });

  const opened = await openDatabase({
    version: bootOptions.databaseVersion,
    timeoutMs: bootOptions.openTimeoutMs,
    onBlocking: onDatabaseBlocking,
    onTerminated: () => fatal(new Error("IndexedDB の接続が切られた")),
  });
  if (opened.kind === "blocked") {
    // 開く要求は取り消せない。印を置いて読み込み直し、要求を捨てる。読み込み直したページは、開かずに S00 を出す
    platform.setBlockedFlag(true);
    platform.reload();
    return;
  }
  rt.db = opened.db;
  let meta = await readMeta(opened.db, platform.randomUUID);
  deviceId.value = meta.deviceId;
  soundEnabled.value = meta.sound;
  vibrationEnabled.value = meta.vibration;

  // Discord から戻ってきた
  const login = platform.loginParam();
  if (login !== null) platform.clearQuery();
  let fetched: RecordOperator | null = null;
  let loginFailed = login === "failed";
  if (login === "ok") {
    go({ id: "S01", phase: "loggingIn" });
    const me = await rt.ports.network.fetchMe();
    if (me.kind === "ok") fetched = me.value;
    else loginFailed = true;
  }

  // 3. ログインしていない。この画面はロックを持たないので、接続を閉じる
  const loggedOut = (extra: Partial<Extract<Screen, { id: "S01" }>> = {}) => {
    closeDatabase();
    go({ id: "S01", phase: "idle", ...extra });
  };
  if (login === "no-role") {
    closeDatabase();
    return go({ id: "S01", phase: "noRole", canGoBack: meta.operator !== null });
  }
  if (loginFailed) return loggedOut({ loginFailed: true, canGoBack: meta.operator !== null });
  if (fetched === null && meta.operator === null) return loggedOut();

  // 4. ログイン済み。このオリジンに 1 つのロックを取る。取れなければ、別の画面がログイン済みで動いている
  const release = await locks.acquire();
  if (release === null) {
    closeDatabase();
    return go({ id: "S00", reason: "otherInstance" });
  }
  rt.releaseLock = release;
  // ロックを持っていた画面が、2 の後にログアウトで消していることがある。読み直す
  meta = await readMeta(opened.db, platform.randomUUID);
  const current = fetched ?? meta.operator;
  if (current === null) {
    release();
    rt.releaseLock = null;
    return loggedOut();
  }
  rt.loginEpoch = meta.loginEpoch;
  if (fetched !== null) {
    const value = fetched;
    await enqueue((db) => writeMeta(db, "operator", value));
  }
  const data = await readData(opened.db);
  resetSync();
  deviceId.value = meta.deviceId;
  operator.value = current;
  cursor.value = meta.cursor;
  override.value = meta.override;
  lastSyncAt.value = meta.lastSyncAt;
  config.value = data.config;
  snapshots.value = data.snapshots;
  records.value = data.records;
  needsLogin.value = false;
  lastSyncFailed.value = false;
  now.value = platform.now();
  initReception();
  platform.requestPersist();

  await prepare();
}

/**
 * 配布物と、有効な Service Worker をそろえる（Design Doc 6.4 の 4）。そろっていれば、すぐにホームへ進む。
 * 配布物は、同期を 1 回行って版を得て取得する。Service Worker は、有効になるのを待つ
 */
async function prepare(): Promise<void> {
  const { appShell } = rt.ports;
  const needsData = config.value === null;
  // 開発サーバは Service Worker を配らないので、待たない
  const needsShell = appShell.enabled() && !(await appShell.hasActive());
  let synced = false;
  if (needsData || needsShell) {
    go({ id: "S01", phase: "fetching" });
    setPreparing(true);
    const [outcome, shellReady] = await Promise.all([
      needsData ? runSync() : Promise.resolve("ok" as const),
      needsShell ? appShell.waitActive(APP_SHELL_WAIT_MS) : Promise.resolve(true),
    ]);
    setPreparing(false);
    if (rt.failed || rt.db === null) return;
    synced = needsData && outcome === "ok";
    if (outcome === "unauthorized") {
      // セッションが切れている。「再試行」を繰り返しても取得できない
      checkForUpdate();
      return go({ id: "S01", phase: "needsLogin" });
    }
    // 応答の versions が null（まだ公開していない）のときも、配布物がないので取得失敗になる
    const failed = { data: config.value === null, app: !shellReady };
    if (failed.data || failed.app) {
      checkForUpdate();
      return go({ id: "S01", phase: "fetchFailed", failed });
    }
  }

  // 5. ホームの停止中に移り、同期を予約する
  go({ id: "home", mode: { kind: "idle" } });
  stopTicker ??= rt.ports.platform.startTicker(tick);
  if (synced) deferNextSync();
  else void runSync();
}

/** S01 の取得失敗の「再試行」。そろっていないほうをやり直す。Service Worker は register() からやり直す */
export async function retryPrepare(): Promise<void> {
  const current = screen.value;
  if (current.id !== "S01" || current.phase !== "fetchFailed" || rt.db === null) return;
  // インストールに失敗した登録は捨てられる。呼び直さなければ、再インストールが始まらない
  rt.ports.appShell.register();
  try {
    await prepare();
  } catch (error) {
    fatal(error);
  }
}

/**
 * 「Discord でログイン」「別のアカウントでログイン」。同じ画面のまま GET /auth/discord/start に移動する。
 * 再ログインでも、端末のデータは消さない。ページが破棄された時点でロックは外れ、戻った画面が取り直す
 */
export function startLogin(): void {
  if (screen.value.id !== "S01") return;
  stopSchedule();
  abortSync();
  rt.ports.platform.goToLogin();
}

/** ヘッダの「再ログインが必要」と、S09 の「今すぐ同期」から、S01 で再ログインする。受付操作の途中は何もしない */
export function startRelogin(): void {
  if (midOperation.value || rt.db === null) return;
  const current = screen.value;
  // ヘッダを置く画面のうち、受付操作の途中（画面設計書 2.7）でないもの。S05 と S07 でも効く（画面設計書 2.3、2.8）
  if (current.id !== "home" && current.id !== "S09" && current.id !== "S05" && current.id !== "S07") return;
  rt.ports.camera.stop();
  go({ id: "S01", phase: "idle", canGoBack: true });
}

/** S01 の左上の「戻る」。再ログインせずに S02 に戻る（FR-36） */
export async function backFromLogin(): Promise<void> {
  const current = screen.value;
  if (current.id !== "S01" || current.canGoBack !== true) return;
  if (rt.db !== null && rt.releaseLock !== null) {
    // ヘッダから来て、まだ Discord に移っていない。「Discord でログイン」を押した後に移動が成立せず
    // （オフラインなど）、このページに戻ってきた場合もここを通る。startLogin() が止めた 1 秒ごとの処理を
    // 動かし直す。止めたままだと、受付の自動の切り替えと定期の同期が、再読み込みまで止まる（FR-6、FR-40）
    go({ id: "home", mode: { kind: "idle" } });
    stopTicker ??= rt.ports.platform.startTicker(tick);
    return;
  }
  // Discord から、失敗かロールなしで戻った。ロックを取り直して、端末のデータで起動をやり直す
  go({ id: "boot" });
  try {
    await start();
  } catch (error) {
    fatal(error);
  }
}

/** S09 の「ログアウト」。確認のダイアログを開く */
export function openLogoutConfirm(): void {
  if (screen.value.id !== "S09" || overlay.value !== null) return;
  setOverlay({ id: "S09-D1" });
}

/**
 * S09-D1 の「ログアウト」。端末のデータを消して、S01 の「未ログイン」に進む（FR-37、Design Doc 6.13）。
 * オフラインでもログアウトできる。Cookie は、期限切れか次のログインの上書きに任せる
 */
export async function logout(): Promise<void> {
  if (overlay.value?.id !== "S09-D1" || busy.value || rt.db === null) return;
  busy.value = true;
  // 1. 同期の予約を止め、進行中の同期と取得を中断し、ログインの番号を上げる。ここまでを、列を待たずに行う
  stopSchedule();
  abortSync();
  rt.loginEpoch++;
  const epoch = rt.loginEpoch;
  // 2. 消去を列に入れる。先に列にある処理は、ログインの番号の照合で、何も書かずに終える
  await enqueue((db) => clearForLogout(db, epoch), { ignoreEpoch: true });
  busy.value = false;
  if (rt.failed) return;
  // 3. 接続を閉じ、ロックを外して、POST /auth/logout を送る
  closeDatabase();
  rt.releaseLock?.();
  rt.releaseLock = null;
  void rt.ports.network.logout();

  rt.ports.camera.stop();
  resetSync();
  operator.value = null;
  cursor.value = null;
  override.value = null;
  lastSyncAt.value = null;
  config.value = null;
  snapshots.value = [];
  records.value = [];
  confirmedReception.value = { reception: null, manual: false };
  syncInFlight.value = false;
  needsLogin.value = false;
  lastSyncFailed.value = false;
  judging.value = false;
  notice.value = null;
  overlay.value = null;
  go({ id: "S01", phase: "idle" });
}
