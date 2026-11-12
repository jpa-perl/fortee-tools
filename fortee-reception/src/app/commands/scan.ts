import type { Reception } from "../../core/config.ts";
import { judge, type JudgeInput, parseTicketQr } from "../../core/judge.ts";
import { type CheckinRecord, checkinRecordSchema } from "../../core/record.ts";
import { createCheckinRecords } from "../../core/records.ts";
import { snapshotIndex, ticketStates } from "../state/derived.ts";
import {
  busy,
  type CameraState,
  config,
  confirmedReception,
  type DeviceRecord,
  deviceId,
  judging,
  now,
  operator,
  overlay,
  records,
  scanBanner,
  screen,
  soundEnabled,
  vibrationEnabled,
} from "../state/model.ts";
import { candidateView, toneOf } from "../state/views.ts";
import { addRecords, type Database } from "../storage/db.ts";
import { applyOverride, refreshReception } from "./reception.ts";
import { enqueue, go, rt, setJudging, setOverlay } from "./runtime.ts";

// 読み取りと判定（Design Doc 6.5、6.13）。検索からのチェックインと、提案からの切り替えも、同じ判定を通る。

/** チケット QR を読み取らないまま、停止中に戻すまでの時間（画面設計書 2.6） */
export const SCAN_TIMEOUT_MS = 2 * 60_000;
/** 結果から読み取り中に戻った直後に、直前に判定したチケットを無視する時間 */
export const REREAD_IGNORE_MS = 3000;
/** QR 形式外のバナーを出しておく時間 */
const BANNER_MS = 2000;
/** 同じ内容の QR を「写し続けている」と見なす、読み取りの間隔の上限 */
const SAME_CONTENT_MS = 3000;

/** 読み取り中になった時刻。2 分の計時の起点。QR 形式外の読み取りでは更新しない */
let scanStartedAt = 0;
/** 直前に判定したチケットと、無視を終える時刻 */
let ignored: { tokens: Set<string>; until: number } | null = null;
/** 直前に出した QR 形式外の内容と、最後に写った時刻 */
let lastInvalid: { text: string; seenAt: number } | null = null;
let cancelBanner: (() => void) | null = null;
/** カメラの使用が拒否されている端末か。結果の主ボタンの行き先を変える */
let cameraDenied = false;
/** start() の世代。古い開始の結果を捨てる */
let scanSession = 0;

const isScanning = () => screen.value.id === "home" && screen.value.mode.kind === "scanning";

function setCamera(camera: CameraState): void {
  if (isScanning()) go({ id: "home", mode: { kind: "scanning", camera } });
}

async function startCamera(): Promise<void> {
  const session = ++scanSession;
  const result = await rt.ports.camera.start(handleDecoded);
  if (session !== scanSession || !isScanning()) return;
  cameraDenied = result === "denied";
  setCamera(result);
}

/**
 * S02 の「QR コード読み取り」。音を鳴らせる状態にし、カメラを開始して、読み取り中（S03）にする。
 * タップの処理の中で呼ぶ。受付なしのときは何もしない（FR-7）
 */
export function startScan(): void {
  const current = screen.value;
  if (current.id !== "home" || current.mode.kind !== "idle" || overlay.value !== null) return;
  if (confirmedReception.value.reception === null) return;
  rt.ports.feedback.unlock();
  scanStartedAt = rt.ports.platform.now();
  lastInvalid = null;
  go({ id: "home", mode: { kind: "scanning", camera: "requesting" } });
  void startCamera();
}

/** S03 の「もう一度試す」。カメラの使用の許可を、もう一度求める（FR-27） */
export function retryCamera(): void {
  if (!isScanning()) return;
  setCamera("requesting");
  void startCamera();
}

/** 映像を出す要素を渡す。S03 が、video 要素の ref で呼ぶ。外すときは null */
export function attachCameraVideo(video: HTMLVideoElement | null): void {
  rt.ports.camera.attach(video);
}

function stopCamera(): void {
  scanSession++;
  rt.ports.camera.stop();
  cancelBanner?.();
  scanBanner.value = false;
}

/** 読み取り中を終えて、カメラを止める。ほかの画面へ移る操作が呼ぶ。読み取りを受理した後は、止めない */
export function leaveScan(): boolean {
  if (judging.value) return false;
  if (isScanning()) stopCamera();
  return true;
}

/** S03 の「終了」。停止中（S02）に戻す。読み取りを受理した後は、結果を出すまで戻さない */
export function stopScan(): void {
  if (!isScanning() || !leaveScan()) return;
  go({ id: "home", mode: { kind: "idle" } });
}

/** 1 秒ごとに呼ぶ。チケット QR を 2 分間読み取らなければ、許可待ちと拒否の状態も含めて、停止中に戻す */
export function scanTick(time: number): void {
  if (isScanning() && time - scanStartedAt >= SCAN_TIMEOUT_MS) stopScan();
}

/** バックグラウンドに回った。カメラを止め、読み取り中だったら停止中にする（画面設計書 2.6） */
export function onHidden(): void {
  stopScan();
}

function notify(kind: Parameters<typeof toneOf>[0]): void {
  const tone = toneOf(kind);
  if (soundEnabled.value) rt.ports.feedback.play(tone);
  if (vibrationEnabled.value) rt.ports.feedback.vibrate(tone);
}

/**
 * 判定し、新たに済みにするチケットがあれば記録を作って書いてから、結果（S04）にする。
 * 列の 1 つの処理の中で呼ぶ。判定と書き込みのあいだに、同期の結果が入らない（Design Doc 6.13）
 */
async function judgeAndRecord(db: Database, input: JudgeInput, reception: Reception): Promise<void> {
  const index = snapshotIndex.value;
  const settings = config.value;
  const device = deviceId.value;
  const who = operator.value;
  if (index === null || settings === null || device === null || who === null) {
    throw new Error("判定に要る状態がない");
  }
  const time = rt.ports.platform.now();
  now.value = time;
  const judgement = judge(input, reception, index, ticketStates.value, { config: settings, now: time });

  let created: CheckinRecord[] = [];
  if ((judgement.kind === "success" || judgement.kind === "continue") && judgement.newlyDone.length > 0) {
    created = createCheckinRecords({
      tickets: judgement.newlyDone,
      opId: rt.ports.platform.randomUUID(),
      newRecordId: rt.ports.platform.randomUUID,
      reception: reception.id,
      route: input.kind,
      deviceTime: time,
      deviceId: device,
      operator: who,
    });
    // 作った記録を検証する（Design Doc 4.1）。通らないのは実装の誤りで、保存せずに S99 に移る
    for (const record of created) {
      if (!checkinRecordSchema.safeParse(record).success) throw new Error("作った記録が、記録の形に合わない");
    }
    const stored = created.map((record): DeviceRecord => ({ ...record, sent: false, seq: null, receivedAt: null }));
    // 判定の結果を表示する前に書く。失敗したら、結果を表示せずに S99 に移る
    await addRecords(db, stored);
    records.value = [...records.value, ...stored];
  }
  rt.ports.platform.mark("checkin:recorded");
  go({ id: "home", mode: { kind: "result", input, judgement, records: created, reception } });
  notify(judgement.kind);
}

/**
 * デコードした文字列を受け取る。カメラのサービスが、150 ms ごとの結果で呼ぶ。
 * 形式に合い、直後の読み直しに当たらなければ、読み取りを受理してデコードを止め、結果を出すまで
 * 次の読み取りを受理しない（Design Doc 6.13）
 */
export function handleDecoded(text: string): void {
  if (!isScanning() || judging.value) return;
  const time = rt.ports.platform.now();
  const token = parseTicketQr(text);
  if (token === null) {
    // 形式外。同じ内容を写し続けている間は 1 回だけ、2 秒のバナーを出す。2 分の計時は数え直さない
    const same = lastInvalid !== null && lastInvalid.text === text && time - lastInvalid.seenAt < SAME_CONTENT_MS;
    lastInvalid = { text, seenAt: time };
    if (same) return;
    scanBanner.value = true;
    cancelBanner?.();
    cancelBanner = rt.ports.platform.after(BANNER_MS, () => {
      scanBanner.value = false;
    });
    return;
  }
  if (ignored !== null && time < ignored.until && ignored.tokens.has(token)) return;

  // 受理する前に、受付をいまの時刻で確かめ直す。確定している受付を更新するのは 1 秒ごとの処理なので、
  // 期間の境界を跨いだ直後の読み取りが、終わった受付のルールで判定されないようにする（FR-6）。
  // 読み取り中は受付操作の途中ではない（画面設計書 2.7）ので、ここでの切り替えは保留に当たらない。
  // 受付なしになったときは、この中で停止中に戻る（FR-7）
  now.value = time;
  refreshReception();
  if (!isScanning()) return;

  setJudging(true);
  rt.ports.camera.pauseDecoding();
  void enqueue(async (db) => {
    const reception = confirmedReception.value.reception;
    const ticket = snapshotIndex.value?.byToken.get(token);
    stopCamera();
    if (reception === null) {
      // 読み取り中に受付なしになることはない（FR-7 で停止中に戻す）。念のため、記録を作らずに戻す
      go({ id: "home", mode: { kind: "idle" } });
    } else if (ticket === undefined) {
      // 索引にないトークンは、判定を呼ばずに、見つからないを出す（FR-17）
      go({ id: "home", mode: { kind: "notFound", token } });
      notify("notFound");
    } else {
      await judgeAndRecord(db, { kind: "qr", ticket }, reception);
    }
  }).finally(() => setJudging(false));
}

/**
 * S04 の下部の主ボタン（「次へ」「続けて読み取る」「切り替えずに次へ」）。読み取り中（S03）に戻る。
 * カメラの使用が拒否されている端末では S05 に移り、入力欄を空にする。受付なしになっていたら、停止中にとどまる
 */
export function nextFromResult(): void {
  const current = screen.value;
  if (current.id !== "home" || overlay.value !== null) return;
  const mode = current.mode;
  if (mode.kind !== "result" && mode.kind !== "notFound") return;
  rt.ports.feedback.unlock();
  // 直後の 3 秒間は、直前に判定したチケットを読み取っても無視する（画面設計書 2.6）
  const tokens =
    mode.kind === "notFound"
      ? [mode.token]
      : (mode.input.kind === "qr" ? [mode.input.ticket] : mode.input.tickets).map((ticket) => ticket.ticketToken);
  ignored = { tokens: new Set(tokens), until: rt.ports.platform.now() + REREAD_IGNORE_MS };
  // 受付操作の途中が終わる。保留していた受付の切り替えと配布物の差し替えは、ここで反映される
  go({ id: "home", mode: { kind: "idle" } });
  if (cameraDenied) go({ id: "S05", query: "" });
  else startScan();
}

// ───────── S04-M1、S04-M2 ─────────

/** S04 の「参考情報」。シートを開く。描画は views.ts の referenceHtml() */
export function openReference(): void {
  const current = screen.value;
  if (current.id !== "home" || current.mode.kind !== "result" || overlay.value !== null) return;
  setOverlay({ id: "S04-M1" });
}

/** S04 の「{提案する受付名}に切り替えて判定」。確認のシートを開く */
export function openSwitchConfirm(): void {
  const current = screen.value;
  if (current.id !== "home" || current.mode.kind !== "result" || overlay.value !== null) return;
  if (current.mode.judgement.kind !== "suggestSwitch") return;
  setOverlay({ id: "S04-M2" });
}

/**
 * S04-M2 の「切り替える」。受付を提案の受付に切り替え（FR-8 の上書き）、同じチケットを新しい受付で
 * 判定し直して、結果を差し替え、音と振動で知らせ直す（FR-9）
 */
export async function confirmSuggestedSwitch(): Promise<void> {
  const current = screen.value;
  if (overlay.value?.id !== "S04-M2" || busy.value) return;
  if (current.id !== "home" || current.mode.kind !== "result" || current.mode.judgement.kind !== "suggestSwitch") return;
  const { input, judgement } = current.mode;
  rt.ports.feedback.unlock();
  busy.value = true;
  try {
    await enqueue(async (db) => {
      await applyOverride(db, judgement.reception.id);
      const reception = confirmedReception.value.reception;
      if (reception === null) throw new Error("切り替えた受付が設定にない");
      // その時点の記録で、UserView を作り直す
      await judgeAndRecord(db, input, reception);
      setOverlay(null);
    });
  } finally {
    busy.value = false;
  }
}

// ───────── 検索からのチェックイン（S06-M1） ─────────

/**
 * S06-M1 の「チェックイン」。選んだチケットを読み取ったチケットとみなして判定し（経路は検索）、
 * ホームの結果（S04）に進む。判定は、確定した時点の記録で行う
 */
export async function confirmSearchCheckin(): Promise<void> {
  const current = screen.value;
  if (overlay.value?.id !== "S06-M1" || current.id !== "S06" || busy.value) return;
  const selected = current.selected;
  rt.ports.feedback.unlock();
  busy.value = true;
  try {
    await enqueue(async (db) => {
      const reception = confirmedReception.value.reception;
      const index = snapshotIndex.value;
      // 選んだチケットのうち、現在の受付の「チェックインするイベント」のものだけを使う。
      // S06 は、受付なしのときと、すべてのイベントで 1 枚ずつ選んでいないときには、この操作を出さない。
      // 選んでいないイベントが残ると、検索からは出ないはずの「続けて読み取り」になる（画面設計書 2.4）
      const tickets = (reception?.checkin ?? []).flatMap((eventId) => {
        const ticket = index?.byToken.get(selected[eventId] ?? "");
        return ticket !== undefined && ticket.eventId === eventId ? [ticket] : [];
      });
      if (reception === null || tickets.length === 0 || candidateView()?.complete !== true) {
        setOverlay(null);
        return;
      }
      overlay.value = null;
      await judgeAndRecord(db, { kind: "search", tickets }, reception);
    });
  } finally {
    busy.value = false;
  }
}
