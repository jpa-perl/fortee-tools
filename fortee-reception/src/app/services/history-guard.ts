import type { HistoryGuard } from "./ports.ts";

// Android の戻る操作の番人（Design Doc 6.9）。
//
// 画面の切り替えは状態で行い、URL は変えない。History API は、戻る操作を受け取るためだけに使う。
// 戻る操作に割り当てのある画面にいる間は、同じ URL のエントリを 1 つだけ積んでおく（番人のエントリ）。
// 割り当てのない画面では積まないので、戻る操作で Android の通常の挙動のとおりアプリが閉じる。

/** History API のうち、番人が使う部分。テストでは偽物を渡す */
export type HistoryLike = {
  replaceState(data: unknown, unused: string): void;
  pushState(data: unknown, unused: string): void;
  back(): void;
};

const BASE = { checkin: "base" };
const SENTINEL = { checkin: "sentinel" };

export function createHistoryGuard(
  history: HistoryLike,
  onPopState: (listener: () => void) => void,
): HistoryGuard {
  /** 番人のエントリが積まれているか */
  let pushed = false;
  /** 自分で呼んだ back() による popstate の数。戻る操作として扱わない */
  let ignore = 0;
  let wanted = false;

  function apply() {
    // 自分の back() が届くまでは、積み直さない。届く前に積むと、積んだエントリが back() で外れる
    if (ignore > 0) return;
    if (wanted && !pushed) {
      history.pushState(SENTINEL, "");
      pushed = true;
    } else if (!wanted && pushed) {
      pushed = false;
      ignore++;
      history.back();
    }
  }

  return {
    init(onBack) {
      history.replaceState(BASE, "");
      onPopState(() => {
        if (ignore > 0) {
          ignore--;
          apply();
          return;
        }
        // 戻る操作で、番人のエントリが外れた
        pushed = false;
        onBack();
        // 移った先にも割り当てがあれば（結果では画面を変えないまま）、積み直す
        apply();
      });
    },
    setArmed(armed) {
      wanted = armed;
      apply();
    },
  };
}
