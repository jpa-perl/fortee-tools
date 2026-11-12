import type { Locks, Platform, WakeLock } from "./ports.ts";

// ブラウザの環境との接点: 開き方の判定、オンライン、可視性、ロック、記憶域の永続化、画面のスリープ。

/** このオリジンに 1 つのロックの名前（Design Doc 6.4） */
const LOCK_NAME = "checkin-instance";
/** 更新の待機で止めた印の sessionStorage のキー（Design Doc 6.4 の 2） */
const BLOCKED_FLAG = "checkin-blocked";

export function createPlatform(): Platform {
  return {
    now: () => Date.now(),
    randomUUID: () => crypto.randomUUID(),
    random: () => Math.random(),
    isIosSafariTab() {
      // iPadOS は Mac の UA を名乗るので、タッチの点数でも見る。iOS の版は UA から判定しない（端末の挙動 10 章）
      const ios =
        /iPhone|iPad|iPod/.test(navigator.userAgent) ||
        (navigator.userAgent.includes("Macintosh") && navigator.maxTouchPoints > 1);
      return ios && (navigator as { standalone?: boolean }).standalone !== true;
    },
    isBrowserTab: () => window.matchMedia("(display-mode: browser)").matches,
    online: () => navigator.onLine,
    onOnlineChange(listener) {
      window.addEventListener("online", () => listener(true));
      window.addEventListener("offline", () => listener(false));
    },
    visible: () => document.visibilityState === "visible",
    onVisibilityChange(listener) {
      document.addEventListener("visibilitychange", () => listener(document.visibilityState === "visible"));
    },
    loginParam: () => new URLSearchParams(location.search).get("login"),
    clearQuery() {
      history.replaceState(history.state, "", location.pathname);
    },
    goToLogin() {
      location.assign("/auth/discord/start");
    },
    reload() {
      location.reload();
    },
    blockedFlag() {
      try {
        return sessionStorage.getItem(BLOCKED_FLAG) !== null;
      } catch {
        return false;
      }
    },
    setBlockedFlag(on) {
      try {
        if (on) sessionStorage.setItem(BLOCKED_FLAG, "1");
        else sessionStorage.removeItem(BLOCKED_FLAG);
      } catch {
        // sessionStorage を使えない設定でも、起動は進める
      }
    },
    requestPersist() {
      // 確認は出ず、使われ方から可否が決まる。認められなくても、次の起動でまた要求する（Design Doc 6.3）
      void navigator.storage?.persist?.().catch(() => {});
    },
    async persisted() {
      try {
        return (await navigator.storage?.persisted?.()) ?? false;
      } catch {
        return false;
      }
    },
    startTicker(listener) {
      const timer = setInterval(listener, 1000);
      return () => clearInterval(timer);
    },
    after(ms, listener) {
      const timer = setTimeout(listener, ms);
      return () => clearTimeout(timer);
    },
    mark(name) {
      try {
        // 同じ名前の印は、最新の 1 つだけを残す。読み取り中は 150 ms ごとに付けるので、消さないと増え続ける
        performance.clearMarks(name);
        performance.mark(name);
      } catch {
        // 計測の印は、付けられなくてもよい
      }
    },
  };
}

export function createLocks(): Locks {
  // Web Locks のないブラウザは、対応ブラウザ（NFR-3）にない。ない場合は、止めずに進める
  const locks = () => (navigator as { locks?: LockManager }).locks;
  return {
    async isHeld() {
      const manager = locks();
      if (manager === undefined) return false;
      const state = await manager.query();
      return (state.held ?? []).some((lock) => lock.name === LOCK_NAME);
    },
    acquire() {
      const manager = locks();
      if (manager === undefined) return Promise.resolve(() => {});
      return new Promise((resolve) => {
        // 待たない（ifAvailable）。待つ作りにすると、忘れられたタブが、アプリを閉じた隙にロックを取る。
        // 奪取（steal）も使わない（Design Doc 6.4）
        void manager.request(LOCK_NAME, { ifAvailable: true }, (lock) => {
          if (lock === null) {
            resolve(null);
            return undefined;
          }
          // 手放すまで解決しない Promise を返して、ロックを持ち続ける。ページが破棄されれば外れる
          return new Promise<void>((release) => resolve(release));
        });
      });
    },
  };
}

export function createWakeLock(): WakeLock {
  let wanted = false;
  let sentinel: WakeLockSentinel | null = null;

  async function apply() {
    if (!("wakeLock" in navigator)) return;
    if (wanted && sentinel === null && document.visibilityState === "visible") {
      try {
        const acquired = await navigator.wakeLock.request("screen");
        acquired.addEventListener("release", () => {
          if (sentinel === acquired) sentinel = null;
        });
        if (wanted && sentinel === null) sentinel = acquired;
        else void acquired.release().catch(() => {});
      } catch {
        // 電池の残量などで取れないことがある。取れなくても受付は続ける
      }
    } else if (!wanted && sentinel !== null) {
      const held = sentinel;
      sentinel = null;
      void held.release().catch(() => {});
    }
  }

  // Wake Lock はページが隠れると解放されるので、表示に戻ったときに取り直す（端末の挙動 7 章）
  document.addEventListener("visibilitychange", () => void apply());

  return {
    set(on) {
      wanted = on;
      void apply();
    },
  };
}
