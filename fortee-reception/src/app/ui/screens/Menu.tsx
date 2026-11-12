import type { ComponentChildren } from "preact";
import {
  openLogoutConfirm,
  setSoundEnabled,
  setVibrationEnabled,
  tapSync,
  testSound,
} from "../../commands/index.ts";
import { APP_RELEASE } from "../../build-info.ts";
import {
  canVibrate,
  dataVersions,
  deviceLabel,
  formatClock,
  lastSyncAt,
  offlineReady,
  operator,
  soundEnabled,
  storagePersisted,
  syncStatus,
  vibrationEnabled,
} from "../../state/index.ts";
import { Button } from "../Button.tsx";
import { Header, SyncStatusIcon } from "../Header.tsx";
import { ScreenFrame } from "../ScreenFrame.tsx";

function Row({ label, children }: { label: string; children: ComponentChildren }) {
  return (
    <div class="flex min-h-14 items-center gap-4 border-b border-divider px-4 py-2 last:border-b-0">
      <dt class="w-16 shrink-0 font-bold text-ink-sub">{label}</dt>
      <dd class="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-2">{children}</dd>
    </div>
  );
}

/** オン・オフの切り替え。label は、読み上げの名前（行の見出しと同じ） */
function Switch({ label, checked, onChange }: { label: string; checked: boolean; onChange: (next: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      class="flex min-h-12 items-center rounded-pressable"
      onClick={() => onChange(!checked)}
    >
      <span class="switch-track" />
    </button>
  );
}

/** S09 メニュー。端末の設定と状態の確認、ログアウトを行う */
export function Menu() {
  const status = syncStatus.value;
  const lastSync = lastSyncAt.value;
  const ready = offlineReady.value;
  return (
    <ScreenFrame header={<Header back="戻る" />}>
      <dl class="mt-4 border-y border-divider bg-surface">
        <Row label="ユーザ">
          <span class="font-bold wrap-anywhere">{operator.value?.operatorName ?? ""}</span>
        </Row>
        <Row label="端末">
          <span class="font-bold">{deviceLabel()}</span>
        </Row>
        <Row label="データ">
          <ul class="w-full font-bold">
            {dataVersions().map((entry) => (
              <li key={entry.eventId} class="wrap-anywhere">
                {entry.eventName} {entry.version === null ? "" : formatClock(entry.version)}
              </li>
            ))}
          </ul>
          {/* 端末のデータの永続化が認められていないときだけ。認められているときは、何も出さない */}
          {storagePersisted.value === false && (
            <p class="w-full text-5">空き容量が減ると、端末のデータが消されることがあります</p>
          )}
        </Row>
        <Row label="アプリ">
          <span class="w-full font-bold wrap-anywhere">{APP_RELEASE}</span>
          {ready !== null && (
            <p class="w-full text-5">
              {ready
                ? "オフラインで起動できます"
                : "オフラインでは起動できません。ネットワークのある場所で、アプリを完全に閉じてから開き直してください"}
            </p>
          )}
        </Row>
        <Row label="同期">
          <span class="font-bold tabular-nums">{lastSync === null ? "" : formatClock(lastSync)}</span>
          <SyncStatusIcon />
          <span class="ml-auto">
            {/* 同期中とオフラインのときは押せない。再ログインが必要なときは、押すと S01 で再ログインする */}
            <Button kind="outline" inline disabled={status === "syncing" || status === "offline"} onClick={tapSync}>
              今すぐ同期
            </Button>
          </span>
        </Row>
        <Row label="音">
          <Switch label="音" checked={soundEnabled.value} onChange={(next) => void setSoundEnabled(next)} />
          <span class="ml-auto">
            {/* 成功・注意・拒否の順に鳴らす。音がオフでも鳴らす。タップの処理の中で呼ぶ */}
            <Button kind="outline" inline onClick={testSound}>
              音を試す
            </Button>
          </span>
        </Row>
        {/* 振動に対応した端末だけに置く */}
        {canVibrate.value && (
          <Row label="振動">
            <Switch label="振動" checked={vibrationEnabled.value} onChange={(next) => void setVibrationEnabled(next)} />
          </Row>
        )}
      </dl>
      <div class="p-4 pt-6">
        <Button kind="outline" onClick={openLogoutConfirm}>
          ログアウト
        </Button>
      </div>
    </ScreenFrame>
  );
}
