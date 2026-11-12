import { reloadFromError, reloadFromGuide } from "../../commands/index.ts";
import { browserTab } from "../../state/index.ts";
import { Button } from "../Button.tsx";
import { HomeAppIcon, PlusSquareIcon, ShareIcon } from "../icons.tsx";
import { ScreenFrame } from "../ScreenFrame.tsx";

/** S00 開き方の案内。その開き方では使えないときに出し、ほかの画面には進ませない */
export function Guide({ reason }: { reason: "safariTab" | "otherInstance" }) {
  if (reason === "safariTab") {
    return (
      <ScreenFrame>
        <div class="flex min-h-full flex-col justify-center gap-6 p-6">
          <h1 class="text-2 font-bold">ホーム画面に追加して開いてください</h1>
          <ol class="flex flex-col gap-4">
            <li class="flex items-center gap-3">
              <ShareIcon class="size-8 shrink-0" />
              <span>①「共有」ボタン</span>
            </li>
            <li class="flex items-center gap-3">
              <PlusSquareIcon class="size-8 shrink-0" />
              <span>②「ホーム画面に追加」</span>
            </li>
            <li class="flex items-center gap-3">
              <HomeAppIcon class="size-8 shrink-0" />
              <span>③ ホーム画面のアイコンから開く</span>
            </li>
          </ol>
        </div>
      </ScreenFrame>
    );
  }
  return (
    <ScreenFrame
      footer={
        <Button kind="primary" onClick={reloadFromGuide}>
          再読み込み
        </Button>
      }
    >
      <div class="flex min-h-full flex-col justify-center gap-4 p-6">
        <h1 class="text-2 font-bold">別の画面で開いています</h1>
        <p>
          {browserTab.value
            ? "ホーム画面のアプリかほかのタブで開いているので、このタブは閉じてください"
            : "ブラウザのタブで開いている受付アプリを閉じてから、「再読み込み」を押してください"}
        </p>
      </div>
    </ScreenFrame>
  );
}

/**
 * S99 エラー。想定外のエラーが起きたときに、どの画面からでも移る。
 * 状態を読まずに描けるようにしておく。描画中の例外を受けたエラー境界からも、これを出す
 */
export function ErrorScreen() {
  return (
    <ScreenFrame
      footer={
        <Button kind="primary" onClick={() => void reloadFromError()}>
          再読み込み
        </Button>
      }
    >
      <div class="flex min-h-full flex-col justify-center p-6">
        <h1 class="text-2 font-bold">エラーが発生しました</h1>
      </div>
    </ScreenFrame>
  );
}
