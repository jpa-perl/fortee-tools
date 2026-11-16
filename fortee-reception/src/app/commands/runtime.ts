import type { Ports } from "../services/ports.ts";
import { midOperation } from "../state/derived.ts";
import { judging, overlay, type Overlay, type Screen, screen } from "../state/model.ts";
import type { Database } from "../storage/db.ts";
import { closedStore, databaseStore, rehearsalStore, type Store } from "../storage/store.ts";

// 操作（commands）が共有する、Signal にしない実行時の値と、反映の列（Design Doc 6.13）。
//
// 通信の待ちは互いに独立して進め、メモリ上の状態と IndexedDB への反映だけを、この列に並べて 1 つずつ行う。
// 列は Promise をつなぐだけで作る。

type Runtime = {
  /** 外の世界との接点。boot() が入れる */
  ports: Ports;
  /** IndexedDB の接続。持ち続けるのは、ロックを持つ画面だけ（Design Doc 6.3） */
  db: Database | null;
  /** 操作が書き込みに使う記憶域（storage/store.ts）。接続を開いたときに selectStore() が入れる。接続のない間は closedStore */
  store: Store;
  /** ロックを手放す関数。持っていなければ null */
  releaseLock: (() => void) | null;
  /** ログインの番号（Design Doc 6.4）。ログアウトのたびに 1 増える */
  loginEpoch: number;
  /** S99 に移った。以後は何も書かない */
  failed: boolean;
  /** 受付操作の途中が終わったとき、列が空になったときに、保留していたことを反映する。boot() が入れる */
  settle: () => void;
  /** S99 に移ったときに、通信と定期の処理を止める。boot() が入れる */
  halt: () => void;
};

export const rt: Runtime = {
  ports: undefined as unknown as Ports,
  db: null,
  store: closedStore,
  releaseLock: null,
  loginEpoch: 0,
  failed: false,
  settle: () => {},
  halt: () => {},
};

/** 想定外のエラー。S99 に移り、接続を閉じる。S99 では何も書かない（Design Doc 6.3、6.10） */
export function fatal(error: unknown): void {
  if (rt.failed) return;
  rt.failed = true;
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  console.error(error);
  rt.halt();
  closeDatabase();
  judging.value = false;
  overlay.value = null;
  screen.value = { id: "S99", error: message };
  // 読み取り中に移ったときに、カメラを止める。画面が映像の要素を外すだけでは、映像の取り込みと、
  // 150 ms ごとの読み取りの処理が、読み込み直すまで残る。ここで失敗しても、残りの後始末（音の出力を
  // 休ませることも含む）は行う
  try {
    stopCameraAndRest();
  } catch (cause) {
    console.error(cause);
  }
  rt.ports.wakeLock.set(false);
  rt.ports.historyGuard.setArmed(false);
  rt.settle();
}

/**
 * カメラを止めて、音の出力を休ませる。読み取り中かもしれない画面を、操作（commands/scan.ts）の外から終える
 * とき（受付なし、再ログイン、ログアウト、想定外のエラー）に呼ぶ。カメラだけを止めると、音の出力が動いたまま
 * 残る。カメラを止めるのに失敗しても、音の出力は休ませる
 */
export function stopCameraAndRest(): void {
  try {
    rt.ports.camera.stop();
  } finally {
    rt.ports.feedback.rest();
  }
}

// ───────── 記憶域 ─────────

/** 接続を開いた。記憶域は、IndexedDB のものから始める */
export function openedDatabase(db: Database): void {
  rt.db = db;
  selectStore(false);
}

/** 接続を閉じる。接続と記憶域は、ここと openedDatabase() でだけ、そろえて入れ替える */
export function closeDatabase(): void {
  rt.db?.close();
  rt.db = null;
  rt.store = closedStore;
}

/**
 * 記憶域を選ぶ。リハーサルモードなら、記録だけをメモリに置く記憶域にする。モードによる記録の置き場の違いは、
 * ここにだけある。リハーサルモードの記憶域は、選ぶたびに空から始まる
 */
export function selectStore(rehearsal: boolean): Store {
  if (rt.db === null) throw new Error("接続がない");
  const base = databaseStore(rt.db);
  rt.store = rehearsal ? rehearsalStore(base) : base;
  return rt.store;
}

// ───────── 反映の列 ─────────

let tail: Promise<unknown> = Promise.resolve();
let pending = 0;

/** 列が空か。待機中の版の有効化と、versionchange の後の再読み込みの条件に使う */
export function queueIdle(): boolean {
  return pending === 0;
}

/**
 * 列に処理を入れる。処理は、記憶域（store）を受け取り、途中で通信を待たない。
 *
 * - 入れたときとログインの番号が変わっていれば（ログアウトの後）、何もせずに終える
 * - 処理が例外を投げたら（書き込みの失敗、記録の検証の失敗）、S99 に移る
 *
 * 実行しなかったときと失敗したときは undefined を返す
 */
export function enqueue<T>(
  job: (store: Store) => Promise<T> | T,
  options: { ignoreEpoch?: boolean } = {},
): Promise<T | undefined> {
  const epoch = rt.loginEpoch;
  pending++;
  const run = async (): Promise<T | undefined> => {
    try {
      if (rt.failed || rt.db === null) return undefined;
      if (!options.ignoreEpoch && epoch !== rt.loginEpoch) return undefined;
      return await job(rt.store);
    } catch (error) {
      fatal(error);
      return undefined;
    } finally {
      pending--;
    }
  };
  const result = tail.then(run);
  tail = result;
  // 列が空になった時点で、保留していたことを反映する
  void result.then(() => {
    if (pending === 0) rt.settle();
  });
  return result;
}

// ───────── 画面の切り替え ─────────

/** 戻る操作に割り当てのある画面か（Design Doc 6.9）。番人のエントリを積んでおく */
export function hasBackAction(current: Screen): boolean {
  switch (current.id) {
    case "home":
      return current.mode.kind !== "idle";
    case "S01":
      return current.canGoBack === true;
    case "S05":
    case "S06":
    case "S07":
    case "S08":
    case "S09":
      return true;
    default:
      return false;
  }
}

/** 画面のスリープを止める画面か（画面設計書 2.6）。読み取り中、結果、S06 と、それらのシート */
export function needsWakeLock(current: Screen): boolean {
  return current.id === "S06" || (current.id === "home" && current.mode.kind !== "idle");
}

/** 画面かシートを変えた後に呼ぶ。番人、スリープ、保留していたことの反映 */
function afterTransition(): void {
  const current = screen.value;
  rt.ports.historyGuard.setArmed(hasBackAction(current));
  rt.ports.wakeLock.set(needsWakeLock(current));
  if (!midOperation.value) rt.settle();
}

/** 画面を変える。画面の Signal への代入は、ここを通す */
export function go(next: Screen): void {
  if (rt.failed) return;
  screen.value = next;
  afterTransition();
}

/** シートかダイアログを開く、閉じる */
export function setOverlay(next: Overlay): void {
  if (rt.failed) return;
  overlay.value = next;
  afterTransition();
}

/** 読み取りの受理（Design Doc 6.13）の始まりと終わり */
export function setJudging(value: boolean): void {
  judging.value = value;
  if (!value) afterTransition();
}
