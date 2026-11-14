import { nextBoundary } from "../../core/reception.ts";
import { effectiveReception, midOperation, overrideTarget } from "../state/derived.ts";
import {
  busy,
  config,
  confirmedReception,
  notice,
  type NoticeLine,
  now,
  overlay,
  override,
  screen,
} from "../state/model.ts";
import type { Store } from "../storage/store.ts";
import { enqueue, go, rt, setOverlay } from "./runtime.ts";

// 受付の確定、手動の切り替えとその解除（Design Doc 6.2、FR-6〜8）と、画面の下の知らせ。

/** 画面の下の知らせを出しておく時間 */
const NOTICE_MS = 4000;

let noticeId = 0;
let cancelNoticeTimer: (() => void) | null = null;

/** 画面の下に知らせを出す。lines を上から順に並べて同時に出し、数秒で消す（画面設計書 2.7） */
export function showNotice(lines: NoticeLine[]): void {
  if (lines.length === 0) return;
  const id = ++noticeId;
  notice.value = { id, lines };
  cancelNoticeTimer?.();
  cancelNoticeTimer = rt.ports.platform.after(NOTICE_MS, () => {
    if (notice.value?.id === id) notice.value = null;
  });
}

/** 知らせを、消える前に閉じる */
export function dismissNotice(): void {
  cancelNoticeTimer?.();
  notice.value = null;
}

/**
 * 確定している受付を、いまの時刻と手動の上書きから計算し直す。受付操作の途中でないときに呼ぶ。
 * 受付が変わっていれば、知らせの 1 行を返す（出すのは呼び出し側。データの更新の知らせと 2 行に並べるため）。
 * 読み取り中に受付なしになったら、停止中に戻す（FR-7）
 */
export function recomputeReception(): NoticeLine | null {
  const next = effectiveReception.value;
  const previous = confirmedReception.value;
  // 期限を過ぎたか、指す受付が設定から消えた上書きは、消す
  if (override.value !== null && overrideTarget(config.value, override.value, now.value) === null) {
    override.value = null;
    void enqueue((store) => store.writeMeta("override", null));
  }
  if (previous.reception === next.reception && previous.manual === next.manual) return null;
  confirmedReception.value = next;
  if (previous.reception?.id === next.reception?.id) return null;
  if (next.reception === null && screen.value.id === "home" && screen.value.mode.kind === "scanning") {
    rt.ports.camera.stop();
    go({ id: "home", mode: { kind: "idle" } });
  }
  return { kind: "receptionChanged", name: next.reception?.name ?? null };
}

/** 起動のときに、知らせを出さずに確定する */
export function initReception(): void {
  confirmedReception.value = effectiveReception.value;
}

/**
 * スタッフが自分で受付を切り替えたときに、上書きを保存して、確定している受付もその値にする。
 * 列の処理の中から呼ぶ。until は、確定した時刻の次の境界（FR-8）。保留していた自動の切り替えは、
 * 確定している受付をここで書き換えるので、捨てられる。知らせは出さない
 */
export async function applyOverride(store: Store, receptionId: string | null): Promise<void> {
  const settings = config.value;
  if (settings === null) return;
  const time = rt.ports.platform.now();
  now.value = time;
  const next = receptionId === null ? null : { receptionId, until: nextBoundary(settings, time) };
  await store.writeMeta("override", next);
  override.value = next;
  confirmedReception.value = effectiveReception.value;
}

// ───────── S02-M1 ─────────

/** S02 の受付のカードから、受付の切り替えのシートを開く */
export function openReceptionSheet(): void {
  if (screen.value.id !== "home" || screen.value.mode.kind !== "idle" || overlay.value !== null) return;
  setOverlay({ id: "S02-M1", step: { kind: "list" } });
}

/** 一覧の行を選んで、確認に切り替える。いまの受付の行は選べない */
export function chooseReception(receptionId: string): void {
  if (overlay.value?.id !== "S02-M1" || confirmedReception.value.reception?.id === receptionId) return;
  setOverlay({ id: "S02-M1", step: { kind: "confirm", change: { kind: "switch", receptionId } } });
}

/** 「自動に戻す」を選んで、確認に切り替える */
export function chooseAutoReception(): void {
  if (overlay.value?.id !== "S02-M1" || !confirmedReception.value.manual) return;
  setOverlay({ id: "S02-M1", step: { kind: "confirm", change: { kind: "reset" } } });
}

/** 確認の「やめる」と、確認での戻る操作。一覧に戻る */
export function backToReceptionList(): void {
  if (overlay.value?.id !== "S02-M1") return;
  setOverlay({ id: "S02-M1", step: { kind: "list" } });
}

/** 確認の「切り替える」「戻す」。シートを閉じて、受付のカードを更新する */
export async function confirmReceptionChange(): Promise<void> {
  const sheet = overlay.value;
  if (sheet?.id !== "S02-M1" || sheet.step.kind !== "confirm" || busy.value) return;
  const change = sheet.step.change;
  busy.value = true;
  try {
    await enqueue(async (store) => {
      await applyOverride(store, change.kind === "switch" ? change.receptionId : null);
      setOverlay(null);
    });
  } finally {
    busy.value = false;
  }
}

/** 受付操作の途中でなければ、受付を計算し直して、変わっていれば知らせる。1 秒ごとと、途中が終わったときに呼ぶ */
export function refreshReception(): void {
  if (midOperation.value) return;
  const line = recomputeReception();
  if (line !== null) showNotice([line]);
}
