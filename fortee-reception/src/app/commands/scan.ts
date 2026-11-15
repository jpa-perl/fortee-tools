import type { Reception } from "../../core/config.ts";
import { checkinStep, judge, type Judgement, type JudgeInput, newlyDoneOf, parseTicketQr } from "../../core/judge.ts";
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
  fastCheckin,
  judging,
  now,
  operator,
  overlay,
  records,
  rehearsal,
  scanBanner,
  screen,
  soundEnabled,
  vibrationEnabled,
} from "../state/model.ts";
import { candidateView, toneOf } from "../state/views.ts";
import type { Store } from "../storage/store.ts";
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

/**
 * カメラを止める。音の出力は、ここでは休ませない。読み取りを受理した後は、判定と書き込みの後に結果の音を
 * 鳴らすので、その後で休ませる（restUnlessScanning()）。先に休ませると、書き込みに時間がかかったときに、
 * 鳴らす前に音の出力が休む
 */
function stopCamera(): void {
  scanSession++;
  rt.ports.camera.stop();
  cancelBanner?.();
  scanBanner.value = false;
}

/**
 * 音を鳴らす予定がなくなっていれば、音の出力を休ませる。音を鳴らせる状態にした（unlock()）操作が、終わりに呼ぶ。
 * 読み取り中は、結果の音を鳴らす予定があるので、休ませない。呼び忘れると、音の出力が動いたまま残る
 */
function restUnlessScanning(): void {
  if (!isScanning()) rt.ports.feedback.rest();
}

/** 読み取り中を終えて、カメラを止める。ほかの画面へ移る操作が呼ぶ。読み取りを受理した後は、止めない */
export function leaveScan(): boolean {
  if (judging.value) return false;
  if (isScanning()) {
    stopCamera();
    rt.ports.feedback.rest();
  }
  return true;
}

/**
 * S03 の「終了」。停止中（S02）に戻す。読み取りを受理した後は、結果を出すまで戻さない。
 * 通常受付の確認（S03-D1）は読み取り中ではないので、2 分の経過とバックグラウンドへの移行でも、出し続ける
 */
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

/** リハーサルモードで結果を出したときに、「リハーサルモードです」（S04-D1）を重ねる */
function announceRehearsal(): void {
  if (rehearsal.value) setOverlay({ id: "S04-D1" });
}

/** いまの時刻と記録で判定する。記録は作らない */
function judgeNow(input: JudgeInput, reception: Reception): Judgement {
  const index = snapshotIndex.value;
  const settings = config.value;
  if (index === null || settings === null) throw new Error("判定に要る状態がない");
  const time = rt.ports.platform.now();
  now.value = time;
  return judge(input, reception, index, ticketStates.value, { config: settings, now: time });
}

/**
 * 判定し、新たに済みにするチケットがあれば記録を作って書いてから、結果（S04）にする。
 * 列の 1 つの処理の中で呼ぶ。判定と書き込みのあいだに、同期の結果が入らない（Design Doc 6.13）。
 * 同じ処理の中で済ませた判定があれば、judgement に渡す。省くと、ここで判定する
 */
async function judgeAndRecord(
  store: Store,
  input: JudgeInput,
  reception: Reception,
  judgement: Judgement = judgeNow(input, reception),
): Promise<void> {
  const device = deviceId.value;
  const who = operator.value;
  if (device === null || who === null) throw new Error("判定に要る状態がない");
  const time = now.value;
  const newlyDone = newlyDoneOf(judgement);

  let created: CheckinRecord[] = [];
  if (newlyDone.length > 0) {
    created = createCheckinRecords({
      tickets: newlyDone,
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
    await store.addRecords(stored);
    records.value = [...records.value, ...stored];
  }
  rt.ports.platform.mark("checkin:recorded");
  go({ id: "home", mode: { kind: "result", input, judgement, records: created, reception } });
  notify(judgement.kind);
  announceRehearsal();
}

/**
 * デコードした文字列を受け取る。カメラのサービスが、150 ms ごとの結果で呼ぶ。
 * 形式に合い、直後の読み直しに当たらなければ、読み取りを受理してデコードを止め、結果を出すまで
 * 次の読み取りを受理しない（Design Doc 6.13）。読み取り中にダイアログ（リハーサルモードの帯から開く S09-D2）を
 * 出している間も受理しない
 *
 * 通常受付（高速受付がオフ）で、新たに済みにするチケットのある判定のときは、記録を作る前に、名前を出して
 * 確認する（S03-D1）。確認するかは core の checkinStep() が決める
 */
export function handleDecoded(text: string): void {
  if (!isScanning() || judging.value || overlay.value !== null) return;
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
  void enqueue(async (store) => {
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
      announceRehearsal();
    } else {
      const input: JudgeInput = { kind: "qr", ticket };
      const judgement = judgeNow(input, reception);
      if (checkinStep(judgement, fastCheckin.value) === "confirm") {
        // ここでは記録を作らない。確定のときに、その時点の記録で判定し直す
        go({ id: "home", mode: { kind: "confirming", ticket } });
      } else {
        await judgeAndRecord(store, input, reception, judgement);
      }
    }
  }).finally(() => {
    setJudging(false);
    // 結果の音は、鳴らし終えている（鳴り終わるまでの時間は、音の出力の側が待つ）
    restUnlessScanning();
  });
}

// ───────── 通常受付の確認（S03-D1） ─────────

/** 通常受付の確認を出していれば、読み取ったチケットを返す */
function confirmingTicket() {
  const current = screen.value;
  return current.id === "home" && current.mode.kind === "confirming" ? current.mode.ticket : null;
}

/**
 * S03-D1 の「続ける」。読み取ったチケットを、確定した時点の記録で判定し直して、結果（S04）に進む。
 * 確認を出している間に、ほかの端末の記録が届いていることがある
 */
export async function confirmQrCheckin(): Promise<void> {
  const ticket = confirmingTicket();
  if (ticket === null || busy.value) return;
  rt.ports.feedback.unlock();
  // NFR-1 の計測の始点を、「続ける」を押した時点に置き直す。通常受付では、読み取りから結果までに、確認を
  // 読んで押すまでの時間が入る。受付アプリの処理の時間として測るのは、押してから結果を出すまでである
  rt.ports.platform.mark("checkin:frame");
  busy.value = true;
  try {
    await enqueue(async (store) => {
      const reception = confirmedReception.value.reception;
      // 確認を出している間は受付操作の途中で、受付は変わらない。念のため、受付なしなら記録を作らずに戻す
      if (reception === null) go({ id: "home", mode: { kind: "idle" } });
      else await judgeAndRecord(store, { kind: "qr", ticket }, reception);
    });
  } finally {
    busy.value = false;
    restUnlessScanning();
  }
}

/**
 * S03-D1 の「やめる」と、確認での戻る操作。記録を作らずに、読み取り中（S03）に戻って、カメラを始め直す。
 * 直後の 3 秒間は、同じチケットを読み取っても無視する。来場者の QR がカメラの前に残っていると、
 * すぐに同じ確認が出てしまうためである
 */
export function cancelQrCheckin(): void {
  const ticket = confirmingTicket();
  if (ticket === null || busy.value) return;
  rt.ports.feedback.unlock();
  const time = rt.ports.platform.now();
  ignored = { tokens: new Set([ticket.ticketToken]), until: time + REREAD_IGNORE_MS };
  scanStartedAt = time;
  lastInvalid = null;
  // 受付操作の途中が終わる。保留していた受付の切り替えで受付なしになったら、この中で停止中に戻る（FR-7）
  go({ id: "home", mode: { kind: "scanning", camera: "requesting" } });
  if (isScanning()) void startCamera();
  else restUnlessScanning();
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
  // 読み取り中に戻らなかった（カメラの使用が拒否されている、受付なしになっていた）。鳴らす予定はない
  restUnlessScanning();
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
    await enqueue(async (store) => {
      await applyOverride(store, judgement.reception.id);
      const reception = confirmedReception.value.reception;
      if (reception === null) throw new Error("切り替えた受付が設定にない");
      // その時点の記録で、UserView を作り直す。シートは、結果を出す前に閉じる。リハーサルモードでは、
      // 結果に「リハーサルモードです」を重ねるので、後から閉じると、それも閉じてしまう
      overlay.value = null;
      await judgeAndRecord(store, input, reception);
    });
  } finally {
    busy.value = false;
    restUnlessScanning();
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
    await enqueue(async (store) => {
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
      await judgeAndRecord(store, { kind: "search", tickets }, reception);
    });
  } finally {
    busy.value = false;
    restUnlessScanning();
  }
}
