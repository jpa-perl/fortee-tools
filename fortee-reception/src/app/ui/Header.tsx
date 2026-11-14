import { goBack, openMenu, tapSync } from "../commands/index.ts";
import { confirmedReception, hasUnsent, syncStatus } from "../state/index.ts";
import {
  ChevronLeftIcon,
  CloudCheckIcon,
  CloudOffIcon,
  CloudUploadIcon,
  MenuIcon,
  SpinnerIcon,
  WarningIcon,
} from "./icons.tsx";
import { receptionEmphasized } from "./Notice.tsx";

// ヘッダ（画面設計書 2.3）。左に戻る操作、中央に受付、右に同期の状態（S02 ではメニューも）。

/** 同期の状態のアイコン。名前は画面設計書 2.3 の表のとおり。S09 の「同期」の行でも使う */
export function SyncStatusIcon() {
  switch (syncStatus.value) {
    case "paused":
      return <CloudOffIcon class="size-7" label="同期を停止中" />;
    case "syncing":
      return <SpinnerIcon class="size-7 animate-spin" label="同期中" />;
    case "offline":
      return hasUnsent.value ? (
        <CloudOffIcon class="size-7" unsent label="オフライン（未同期あり）" />
      ) : (
        <CloudOffIcon class="size-7" label="オフライン" />
      );
    case "needsLogin":
      return <WarningIcon class="size-7" label="再ログインが必要" />;
    case "failed":
      return <WarningIcon class="size-7" label="同期の失敗" />;
    case "pending":
      return <CloudUploadIcon class="size-7" label="未同期あり" />;
    case "synced":
      return <CloudCheckIcon class="size-7" label="同期済み" />;
  }
}

/** 同期の状態。同期の停止、同期中、オフラインでは、押しても何も起きないので、ボタンにしない */
function SyncStatus() {
  const status = syncStatus.value;
  if (status === "paused" || status === "syncing" || status === "offline") {
    return (
      <span class="flex size-12 items-center justify-center">
        <SyncStatusIcon />
      </span>
    );
  }
  return (
    <button type="button" class="flex size-12 items-center justify-center rounded-pressable" onClick={tapSync}>
      <SyncStatusIcon />
    </button>
  );
}

/** 現在の受付。表示だけで、押しても何も起きない */
function ReceptionLabel() {
  const { reception, manual } = confirmedReception.value;
  const emphasis = receptionEmphasized() ? "emphasis" : "";
  if (reception === null) {
    return <span class={`rounded-pressable px-2 py-1 font-bold text-ink-sub ${emphasis}`}>受付なし</span>;
  }
  return (
    <span class={`flex min-w-0 items-center gap-2 rounded-pressable px-2 py-1 ${emphasis}`}>
      <span class="truncate font-bold">{reception.name}</span>
      {manual && <span class="shrink-0 rounded-pressable bg-warn px-2 text-6 font-bold text-on-warn">手動</span>}
    </span>
  );
}

type Props = {
  /** 左の戻る操作。「戻る」か「終了」。S02 と S04 には置かない */
  back?: "戻る" | "終了";
  /** 受付を出すか。S02 では出さず、受付のカードで出す */
  reception?: boolean;
  /** メニュー。S02 にだけ置く */
  menu?: boolean;
};

export function Header({ back, reception, menu }: Props) {
  return (
    <div class="flex h-14 items-center gap-1 px-1">
      <div class="flex min-w-12 flex-1 justify-start">
        {back !== undefined && (
          <button
            type="button"
            class="flex min-h-12 items-center gap-1 rounded-pressable border border-outline bg-surface px-3 font-bold"
            onClick={goBack}
          >
            {back === "戻る" && <ChevronLeftIcon class="size-5" />}
            {back}
          </button>
        )}
      </div>
      <div class="flex min-w-0 shrink justify-center">{reception !== false && <ReceptionLabel />}</div>
      <div class="flex min-w-12 flex-1 justify-end">
        <SyncStatus />
        {menu === true && (
          <button
            type="button"
            class="flex size-12 items-center justify-center rounded-pressable"
            aria-label="メニュー"
            onClick={openMenu}
          >
            <MenuIcon class="size-7" />
          </button>
        )}
      </div>
    </div>
  );
}
