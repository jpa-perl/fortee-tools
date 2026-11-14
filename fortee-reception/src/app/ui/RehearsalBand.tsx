import { openRehearsalExit } from "../commands/index.ts";
import { rehearsal, screen } from "../state/index.ts";
import { CloseIcon } from "./icons.tsx";

/**
 * リハーサルモードの帯。リハーサルモードの間、ログイン後の画面（ホーム、S05〜S09）の上端に、ヘッダに重ねて出す。
 * 帯は縞だけで、押す操作を下のヘッダに通す。帯の右下に下げた札に、モードの名前と「✗」を置く。
 * 「✗」は、通常モードに戻す確認（S09-D2）を開く
 */
export function RehearsalBand() {
  const id = screen.value.id;
  if (!rehearsal.value || id === "boot" || id === "S00" || id === "S01" || id === "S99") return null;
  return (
    <aside class="rehearsal-band" aria-label="リハーサルモード">
      {/* 帯の右下に下げる札。ヘッダの戻る操作、受付、同期の状態、メニューを隠さない */}
      <div class="absolute top-full right-0 flex items-center rounded-bl-pressable bg-warn pl-3 text-on-warn">
        <p class="text-5 font-bold">リハーサルモード</p>
        <button
          type="button"
          class="flex size-12 items-center justify-center rounded-pressable"
          aria-label="通常モードに戻す"
          onClick={openRehearsalExit}
        >
          <CloseIcon class="size-6" />
        </button>
      </div>
    </aside>
  );
}
