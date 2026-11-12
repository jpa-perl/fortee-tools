import { describe, expect, it } from "vitest";
import { createHistoryGuard, type HistoryLike } from "../../src/app/services/history-guard.ts";
import { decodeSize, visibleSourceRect } from "../../src/app/services/scan-region.ts";

// DOM から切り離した関数（Design Doc 11 章）。状態を持つモジュールの関数は、app.test.ts で実体を作って確かめる

describe("読み取る範囲の計算（端末の挙動 11.2、画面設計書 S03）", () => {
  it("縦長の映像を横長の領域に隙間なく収めると、見えているのは映像の中央の帯になる", () => {
    // 3:4 の映像（480x640）を、390x280 の領域に収める。倍率は幅で決まり、高さの 54% が見える
    const rect = visibleSourceRect({ width: 480, height: 640 }, { width: 390, height: 280 });
    expect(rect).not.toBeNull();
    expect(rect?.x).toBe(0);
    expect(rect?.width).toBe(480);
    expect(rect?.height).toBeCloseTo((280 * 480) / 390);
    expect(rect?.y).toBeCloseTo((640 - (280 * 480) / 390) / 2);
    expect((rect?.height ?? 0) / 640).toBeCloseTo(0.54, 2);
  });

  it("横長の映像を縦長の領域に収めると、左右が切れる", () => {
    const rect = visibleSourceRect({ width: 1280, height: 720 }, { width: 360, height: 720 });
    expect(rect).toEqual({ x: (1280 - 360) / 2, y: 0, width: 360, height: 720 });
  });

  it("映像か領域の大きさが決まっていなければ、読み取らない", () => {
    expect(visibleSourceRect({ width: 0, height: 0 }, { width: 390, height: 280 })).toBeNull();
    expect(visibleSourceRect({ width: 480, height: 640 }, { width: 0, height: 280 })).toBeNull();
  });

  it("長辺 640px の上限は、切り出した範囲に当てる。拡大はしない", () => {
    expect(decodeSize({ width: 1920, height: 1080 })).toEqual({ width: 640, height: 360 });
    expect(decodeSize({ width: 480, height: 344.6 })).toEqual({ width: 480, height: 345 });
  });
});

describe("番人のエントリの管理（Design Doc 6.9）", () => {
  /** History の偽物。エントリの積み重ねと、back() による popstate を模す */
  function fakeHistory() {
    const entries: unknown[] = [null];
    let listener: () => void = () => {};
    /** back() で届く popstate。届く順を、テストが決める */
    const pendingPops: (() => void)[] = [];
    const history: HistoryLike = {
      replaceState: (data) => {
        entries[entries.length - 1] = data;
      },
      pushState: (data) => {
        entries.push(data);
      },
      back: () => {
        pendingPops.push(() => {
          entries.pop();
          listener();
        });
      },
    };
    return {
      history,
      entries,
      onPopState: (value: () => void) => {
        listener = value;
      },
      /** 自分の back() による popstate を届ける */
      flush: () => {
        while (pendingPops.length > 0) pendingPops.shift()?.();
      },
      /** 利用者の戻る操作 */
      userBack: () => {
        entries.pop();
        listener();
      },
    };
  }

  it("割り当てのある画面にいる間だけ、エントリを 1 つ積む", () => {
    const h = fakeHistory();
    const guard = createHistoryGuard(h.history, h.onPopState);
    guard.init(() => {});
    expect(h.entries).toHaveLength(1);

    guard.setArmed(true);
    guard.setArmed(true);
    expect(h.entries).toHaveLength(2);

    // 割り当てのない画面（停止中）に移ったら、外す。戻る操作でアプリが閉じるようにする
    guard.setArmed(false);
    h.flush();
    expect(h.entries).toHaveLength(1);
  });

  it("戻る操作を受けたら処理を呼び、移った先にも割り当てがあれば積み直す", () => {
    const h = fakeHistory();
    const guard = createHistoryGuard(h.history, h.onPopState);
    let backs = 0;
    let armedAfterBack = true;
    guard.init(() => {
      backs++;
      guard.setArmed(armedAfterBack);
    });
    guard.setArmed(true);

    // 結果（S04）では画面を変えず、積み直す（FR-22）
    h.userBack();
    expect(backs).toBe(1);
    expect(h.entries).toHaveLength(2);

    // S05 から停止中へ。積み直さない
    armedAfterBack = false;
    h.userBack();
    expect(backs).toBe(2);
    expect(h.entries).toHaveLength(1);
  });

  it("自分で外したエントリの popstate は、戻る操作として扱わない。届く前に積む要求が来ても、数が合う", () => {
    const h = fakeHistory();
    const guard = createHistoryGuard(h.history, h.onPopState);
    let backs = 0;
    guard.init(() => backs++);
    guard.setArmed(true);
    // 結果から読み取り中へ: 停止中を経るので、外してすぐに積む
    guard.setArmed(false);
    guard.setArmed(true);
    h.flush();
    expect(backs).toBe(0);
    expect(h.entries).toHaveLength(2);
  });
});
