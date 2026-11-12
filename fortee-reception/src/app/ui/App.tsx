import { APP_RELEASE, CONFERENCE_NAME } from "../build-info.ts";
import { offlineReady } from "../state/app-shell.ts";
import { ScreenFrame } from "./ScreenFrame.tsx";

/**
 * 基盤の動作を確かめるための仮の画面。画面設計書の画面（S00〜S99）は、まだない。
 * 画面は URL ではなく状態で切り替える（Design Doc 6.9）ので、ルータは置かない
 */
export function App() {
  const ready = offlineReady.value;
  return (
    <ScreenFrame header={<h1 class="px-4 py-3 text-2">{CONFERENCE_NAME}</h1>}>
      <dl class="px-4 py-3">
        <dt class="text-5 text-ink-sub">アプリ</dt>
        <dd data-testid="release">{APP_RELEASE}</dd>
        <dd data-testid="offline-ready" class="pb-3">
          {ready === null ? "確認中" : ready ? "オフラインで起動できます" : "オフラインでは起動できません"}
        </dd>
      </dl>
      <p class="px-4 text-5 text-ink-sub">受付の画面は、まだ実装していません。</p>
    </ScreenFrame>
  );
}
