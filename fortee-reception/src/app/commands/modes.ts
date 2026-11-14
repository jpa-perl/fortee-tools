import { busy, fastCheckin, judging, overlay, override, records, rehearsal, screen } from "../state/model.ts";
import type { Store } from "../storage/store.ts";
import { enqueue, go, selectStore, setOverlay } from "./runtime.ts";
import { leaveScan } from "./scan.ts";
import { abortSync, runSync } from "./sync.ts";

// 高速受付（FR-49）とリハーサルモード（FR-50、Design Doc 6.2）の切り替え（S09、S09-D2、リハーサルモードの帯）。

async function writeFastCheckin(store: Store, enabled: boolean): Promise<void> {
  await store.writeMeta("fastCheckin", enabled);
  fastCheckin.value = enabled;
}

/** 高速受付の設定を書く。ログアウトしても残す */
export async function setFastCheckin(enabled: boolean): Promise<void> {
  await enqueue((store) => writeFastCheckin(store, enabled));
}

/** S09 の「高速受付」の切り替え。オンにするときは、確認のダイアログ（S09-D2）を開く。オフに戻すときは確認しない */
export function requestFastCheckin(enabled: boolean): void {
  if (screen.value.id !== "S09" || overlay.value !== null) return;
  if (enabled) setOverlay({ id: "S09-D2", change: "fastCheckinOn" });
  else void setFastCheckin(false);
}

/** S09 の「リハーサルモード」の切り替え。どちらに切り替えるときも、確認のダイアログ（S09-D2）を開く */
export function requestRehearsal(enabled: boolean): void {
  if (screen.value.id !== "S09" || overlay.value !== null) return;
  setOverlay({ id: "S09-D2", change: enabled ? "rehearsalOn" : "rehearsalOff" });
}

/**
 * リハーサルモードの帯の「✗」。どの画面からでも、通常モードに戻す確認（S09-D2）を開く。
 * 読み取りを受理してから結果を出すまでと、ほかのシートかダイアログ（通常受付の確認を含む）を出している間は、何もしない
 */
export function openRehearsalExit(): void {
  if (!rehearsal.value || overlay.value !== null || judging.value) return;
  const current = screen.value;
  if (current.id === "home" && current.mode.kind === "confirming") return;
  setOverlay({ id: "S09-D2", change: "rehearsalOff" });
}

/**
 * リハーサルモードを切り替える。記憶域を替えて（runtime.ts の selectStore）、記録と受付の手動の上書きを読み直す。
 * リハーサルモードに入ると、記録は空から始まる。通常モードに戻ると、リハーサルの記録は記憶域ごと消えて、
 * 端末の記録に戻る。リハーサルモードの間の受付の切り替えも消えて、入る前の上書きに戻る。
 * オン・オフは、どちらの記憶域でも IndexedDB の meta に書く。
 *
 * リハーサルモードの間は同期しない（sync.ts の runSync）。入るときは、先に同期を止めてから記憶域を替える。
 * 戻るときは、記録を端末の記録に戻してから、同期できるようにする。順が逆だと、リハーサルの記録を送りうる
 */
async function switchRehearsal(store: Store, enabled: boolean): Promise<void> {
  if (enabled) {
    rehearsal.value = true;
    abortSync();
  }
  await store.writeMeta("rehearsal", enabled);
  const next = selectStore(enabled);
  const [nextRecords, nextOverride] = await Promise.all([next.readRecords(), next.readOverride()]);
  records.value = nextRecords;
  override.value = nextOverride;
  rehearsal.value = enabled;
}

/**
 * S09-D2 の確定。通常モードに戻したときは、S09 のほかの画面にいれば、ホームの停止中（S02）に戻す。
 * 結果、S06、S08 が出しているリハーサルの記録が、なくなるためである。
 * 通常モードに戻したら、止めていた同期を始める
 */
export async function confirmModeChange(): Promise<void> {
  const sheet = overlay.value;
  if (sheet?.id !== "S09-D2" || busy.value) return;
  const { change } = sheet;
  busy.value = true;
  try {
    await enqueue(async (store) => {
      if (change === "fastCheckinOn") await writeFastCheckin(store, true);
      else await switchRehearsal(store, change === "rehearsalOn");
      if (change === "rehearsalOff" && screen.value.id !== "S09") {
        overlay.value = null;
        leaveScan();
        go({ id: "home", mode: { kind: "idle" } });
      } else {
        setOverlay(null);
      }
    });
  } finally {
    busy.value = false;
  }
  if (change === "rehearsalOff") void runSync();
}
