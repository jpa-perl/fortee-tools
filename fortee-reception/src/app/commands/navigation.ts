import { syncStatus } from "../state/derived.ts";
import { busy, overlay, screen } from "../state/model.ts";
import { candidateView, defaultSelection } from "../state/views.ts";
import { refreshOfflineReady, refreshStoragePersisted } from "./app-shell.ts";
import { backToReceptionList } from "./reception.ts";
import { go, rt, setOverlay } from "./runtime.ts";
import { leaveScan, stopScan } from "./scan.ts";
import { backFromLogin, startRelogin } from "./session.ts";
import { runSync } from "./sync.ts";

// 画面の移動と、戻る操作（Design Doc 6.9、画面設計書 2.1）。

/** ホームの停止中か読み取り中にいて、ほかの画面へ移れるか。読み取り中ならカメラを止める */
function leaveHome(): boolean {
  const current = screen.value;
  if (current.id !== "home" || overlay.value !== null) return false;
  if (current.mode.kind !== "idle" && current.mode.kind !== "scanning") return false;
  return leaveScan();
}

/** S02 と S03 の「検索」、S03 の「検索で続ける」。入力欄を空にして S05 を開く */
export function openSearch(): void {
  if (leaveHome()) go({ id: "S05", query: "" });
}

/** S05 の入力。入力のたびに呼ぶ */
export function setSearchQuery(query: string): void {
  if (screen.value.id === "S05") go({ id: "S05", query });
}

/** S05 の候補をタップして、S06 を開く。チケットが 1 枚だけのイベントと、済みのチケットは、最初から選んでおく */
export function openCandidate(userName: string): void {
  const current = screen.value;
  if (current.id !== "S05") return;
  go({ id: "S06", userName, selected: defaultSelection(userName), query: current.query });
}

/** S06 で、イベントのチケットを 1 枚選ぶ */
export function selectTicket(eventId: string, ticketToken: string): void {
  const current = screen.value;
  if (current.id !== "S06" || overlay.value !== null) return;
  go({ ...current, selected: { ...current.selected, [eventId]: ticketToken } });
}

/** S06 の「検索からチェックイン」。確認のシートを開く。確定は confirmSearchCheckin() */
export function openSearchCheckinConfirm(): void {
  if (screen.value.id !== "S06" || overlay.value !== null) return;
  // すべてのイベントで 1 枚ずつ選ぶまで、進めない。受付なしと、選べるチケットがないときも同じ（画面設計書 S06）
  if (candidateView()?.complete !== true) return;
  setOverlay({ id: "S06-M1" });
}

/** S02 の「履歴をすべて見る」。検索欄を空にして S07 を開く */
export function openHistory(): void {
  const current = screen.value;
  if (current.id === "home" && current.mode.kind === "idle" && overlay.value === null) go({ id: "S07", filter: "" });
}

/** S07 の検索欄の入力 */
export function setHistoryFilter(filter: string): void {
  if (screen.value.id === "S07") go({ id: "S07", filter });
}

/** S02 と S03 の直近の記録、S07 の記録をタップして、S08 を開く */
export function openOperation(opId: string): void {
  const current = screen.value;
  if (current.id === "S07") go({ id: "S08", opId, from: "S07", filter: current.filter });
  else if (leaveHome()) go({ id: "S08", opId, from: "home" });
}

/** S08 の「取り消す」。確認のシートを開く。確定は confirmCancel() */
export function openCancelConfirm(): void {
  if (screen.value.id === "S08" && overlay.value === null) setOverlay({ id: "S08-M1" });
}

/** S02 のヘッダの「メニュー」。S09 を開き、オフラインで起動できるかと、記憶域の永続化を判定し直す */
export function openMenu(): void {
  const current = screen.value;
  if (current.id !== "home" || current.mode.kind !== "idle" || overlay.value !== null) return;
  go({ id: "S09" });
  void refreshOfflineReady();
  void refreshStoragePersisted();
}

/**
 * シートとダイアログの「閉じる」「やめる」と、下に引いて閉じる操作、dialog の cancel（Android の戻る操作）。
 * 下の画面は変えない。S02-M1 の確認では、閉じずに一覧に戻る（cancel は画面が preventDefault する）
 */
export function closeOverlay(): void {
  const sheet = overlay.value;
  // 確定の処理が進んでいる間は、閉じない
  if (sheet === null || busy.value) return;
  if (sheet.id === "S02-M1" && sheet.step.kind === "confirm") backToReceptionList();
  else setOverlay(null);
}

/**
 * 左上の「戻る」「終了」と、Android の戻る操作（シートもダイアログも開いていないとき）。
 * 結果（S04）では何もしない（FR-22）
 */
export function goBack(): void {
  if (overlay.value !== null) return;
  const current = screen.value;
  switch (current.id) {
    case "home":
      // 読み取り中は「終了」と同じ。結果では何もしない
      if (current.mode.kind === "scanning") stopScan();
      break;
    case "S05":
    case "S07":
    case "S09":
      go({ id: "home", mode: { kind: "idle" } });
      break;
    case "S06":
      // 入力は残す
      go({ id: "S05", query: current.query });
      break;
    case "S08":
      // S07 から開いたときは、S07 の検索欄の入力を残す。ホームから開いたときは、読み取り中からでも停止中へ
      if (current.from === "S07") go({ id: "S07", filter: current.filter ?? "" });
      else go({ id: "home", mode: { kind: "idle" } });
      break;
    case "S01":
      void backFromLogin();
      break;
    default:
      break;
  }
}

/** 番人が受けた戻る操作。シートが開いている間は、dialog の cancel として画面に届くので、ここには来ない見込み */
export function handleBack(): void {
  if (overlay.value !== null) closeOverlay();
  else goBack();
}

/**
 * ヘッダの同期の状態のタップと、S09 の「今すぐ同期」（画面設計書 2.3）。同期中とオフラインでは何もしない。
 * 再ログインが必要なら S01 で再ログインし、ほかは同期する（同期の失敗では再試行）
 */
export function tapSync(): void {
  if (rt.db === null) return;
  switch (syncStatus.value) {
    case "syncing":
    case "offline":
      break;
    case "needsLogin":
      startRelogin();
      break;
    default:
      void runSync();
  }
}
