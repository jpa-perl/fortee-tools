import type { ComponentChildren } from "preact";
import { goBack, retryPrepare, startLogin } from "../../commands/index.ts";
import { CONFERENCE_NAME } from "../../build-info.ts";
import { browserTab, type Screen } from "../../state/index.ts";
import { Button } from "../Button.tsx";
import { isAndroid } from "../env.ts";
import { ChevronLeftIcon, SpinnerIcon } from "../icons.tsx";
import { ScreenFrame } from "../ScreenFrame.tsx";

// S01 ログインとデータ準備。ヘッダは置かない（画面設計書 2.3）。

function Body({ children, back }: { children: ComponentChildren; back?: boolean }) {
  return (
    <div class="safe-top flex min-h-full flex-col">
      {/* 再ログインのとき（端末にデータがあるとき）だけ、左上に「戻る」を置く。ログインせずに S02 に戻れる（FR-36） */}
      <div class="flex h-14 shrink-0 items-center px-1">
        {back === true && (
          <button
            type="button"
            class="flex min-h-12 items-center gap-1 rounded-pressable border border-outline bg-surface px-3 font-bold"
            onClick={goBack}
          >
            <ChevronLeftIcon class="size-5" />
            戻る
          </button>
        )}
      </div>
      <div class="flex flex-1 flex-col items-center justify-center gap-4 px-6 pb-14 text-center">{children}</div>
    </div>
  );
}

function Busy({ label }: { label: string }) {
  return (
    <ScreenFrame>
      <Body>
        <SpinnerIcon class="size-12 animate-spin text-ink-sub" />
        <p class="font-bold">{label}</p>
      </Body>
    </ScreenFrame>
  );
}

const LoginButton = ({ label, kind = "primary" }: { label: string; kind?: "primary" | "outline" }) => (
  <Button kind={kind} onClick={startLogin}>
    {label}
  </Button>
);

export function Login({ state }: { state: Extract<Screen, { id: "S01" }> }) {
  switch (state.phase) {
    case "idle":
      return (
        <ScreenFrame footer={<LoginButton label="Discord でログイン" />}>
          <Body back={state.canGoBack}>
            <h1 class="text-2 font-bold wrap-anywhere">{CONFERENCE_NAME}</h1>
            {state.loginFailed === true && <p class="font-bold">ログインできませんでした</p>}
            {/* Android のブラウザで開いたときだけ。端末のデータを守るため、インストールして使う */}
            {browserTab.value && isAndroid() && (
              <p class="rounded-pressable bg-surface px-4 py-3 font-bold">ホーム画面に追加して使ってください</p>
            )}
          </Body>
        </ScreenFrame>
      );
    case "loggingIn":
      return <Busy label="ログイン中" />;
    case "noRole":
      return (
        <ScreenFrame footer={<LoginButton label="別のアカウントでログイン" kind="outline" />}>
          <Body back={state.canGoBack}>
            <h1 class="font-bold">このアカウントでは使えません</h1>
          </Body>
        </ScreenFrame>
      );
    case "fetching":
      return <Busy label="データを取得中" />;
    case "fetchFailed":
      return (
        <ScreenFrame
          footer={
            <Button kind="primary" onClick={() => void retryPrepare()}>
              再試行
            </Button>
          }
        >
          <Body>
            {/* アプリのファイルの文言は、データを取得できたことも伝えるので、データも取得できなかったときには使わない */}
            <h1 class="font-bold">
              {state.failed?.data === false && state.failed.app
                ? "アプリのファイルを取得できませんでした"
                : "データを取得できませんでした"}
            </h1>
          </Body>
        </ScreenFrame>
      );
    case "needsLogin":
      return (
        <ScreenFrame footer={<LoginButton label="Discord でログイン" />}>
          <Body>
            <h1 class="font-bold">ログインの期限が切れました。もう一度ログインしてください</h1>
          </Body>
        </ScreenFrame>
      );
  }
}
