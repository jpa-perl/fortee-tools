import { type CheckinRecord, TARGET_RECORD_IDS_MAX } from "./record.ts";
import { compareCodeUnits } from "./snapshot.ts";

// 記録の順序、集約、記録を作る補助（Design Doc 5.3、4.4、PRD 7.2）。
//
// 記録の形（スキーマ）は record.ts にある。ここに置くのは、記録から状態を求める規則と、
// 記録を作る純粋な関数である。ID、時刻、端末、操作者は、呼び出し側が引数で渡す。

/**
 * 順序を決められる記録。端末が作る記録に、サーバの受信時刻があればそれを加えたもの。
 * サーバが返す記録（ServerRecord）と、端末に置く記録（受信時刻は、受け取るまで null）のどちらも渡せる
 */
export type OrderedRecord = CheckinRecord & { receivedAt?: number | null };

/**
 * 記録の順序（Design Doc 5.3）。端末の時刻、サーバの受信時刻、記録 ID の順で決める。
 * 受信時刻のない記録（端末にある未送信の記録）は、同じ端末時刻の中では、受信時刻のある記録の後ろに置く
 */
export function compareRecords(a: OrderedRecord, b: OrderedRecord): number {
  if (a.deviceTime !== b.deviceTime) return a.deviceTime < b.deviceTime ? -1 : 1;
  const receivedA = a.receivedAt ?? null;
  const receivedB = b.receivedAt ?? null;
  if (receivedA !== receivedB) {
    if (receivedA === null) return 1;
    if (receivedB === null) return -1;
    return receivedA < receivedB ? -1 : 1;
  }
  return compareCodeUnits(a.recordId, b.recordId);
}

/**
 * チケットの状態（Design Doc 5.3）。
 *
 * - 済み: uncancelled は、打ち消されていないチェックインの記録（compareRecords の順）。
 *   basis はその先頭で、済みの根拠の記録（画面設計書 2.4）
 * - lastCancel は、そのチケットの取り消しの記録のうち、最も遅いもの。取り消しの記録がなければ持たない
 */
export type TicketState<R extends CheckinRecord = CheckinRecord> =
  | { done: true; basis: R; uncancelled: R[]; lastCancel?: R }
  | { done: false; lastCancel?: R };

/** 記録が 1 件もないチケットの状態 */
export const NO_RECORDS: TicketState<never> = Object.freeze({ done: false });

/** チケットの状態を引く。記録のないチケットは未 */
export function stateOf<R extends CheckinRecord>(
  states: ReadonlyMap<string, TicketState<R>>,
  ticketToken: string,
): TicketState<R> {
  return states.get(ticketToken) ?? NO_RECORDS;
}

/**
 * 記録をチケットごとに集約する（PRD 7.2、Design Doc 5.3）。
 *
 * 1. チェックインの記録は、同じチケットの取り消しの記録のどれかが、その記録 ID を targetRecordIds に持てば、打ち消されたものとする
 * 2. 打ち消されていないチェックインの記録があれば済みで、そのうち最も早いものが根拠の記録である。なければ未である
 *
 * 結果は記録の並びによらない。取り消しの端末時刻は、打ち消しの判断に使わない。
 * targetRecordIds が、ほかのチケットの記録、取り消しの記録、入力にない記録を指していても、無視する。
 * 同じ記録 ID の記録が複数あれば、最初の 1 件だけを使う。
 * 返す Map には、記録が 1 件以上あるチケットだけが入る
 */
export function aggregate<R extends OrderedRecord>(records: Iterable<R>): Map<string, TicketState<R>> {
  const byTicket = new Map<string, { checkins: R[]; cancels: R[]; cancelled: Set<string> }>();
  const seen = new Set<string>();
  for (const record of records) {
    if (seen.has(record.recordId)) continue;
    seen.add(record.recordId);
    let group = byTicket.get(record.ticketToken);
    if (group === undefined) {
      group = { checkins: [], cancels: [], cancelled: new Set() };
      byTicket.set(record.ticketToken, group);
    }
    if (record.op === "checkin") {
      group.checkins.push(record);
    } else {
      group.cancels.push(record);
      for (const id of record.targetRecordIds) group.cancelled.add(id);
    }
  }

  const states = new Map<string, TicketState<R>>();
  for (const [ticketToken, group] of byTicket) {
    const uncancelled = group.checkins.filter((record) => !group.cancelled.has(record.recordId)).sort(compareRecords);
    let lastCancel: R | undefined;
    for (const cancel of group.cancels) {
      if (lastCancel === undefined || compareRecords(cancel, lastCancel) > 0) lastCancel = cancel;
    }
    const basis = uncancelled[0];
    const state: TicketState<R> = basis === undefined ? { done: false } : { done: true, basis, uncancelled };
    if (lastCancel !== undefined) state.lastCancel = lastCancel;
    states.set(ticketToken, state);
  }
  return states;
}

/** その記録が、チケットの済みの根拠の記録か（画面設計書 2.4）。取り消せるのは、根拠の記録だけである（FR-29） */
export function isBasis<R extends CheckinRecord>(record: CheckinRecord, states: ReadonlyMap<string, TicketState<R>>): boolean {
  const state = stateOf(states, record.ticketToken);
  return state.done && state.basis.recordId === record.recordId;
}

/**
 * チェックインの記録が打ち消されているか（Design Doc 5.3）。
 * 済みのチケットでは uncancelled にない記録が、未のチケットではすべてのチェックインの記録が、打ち消されている。
 * 取り消しの記録を渡すと false を返す
 */
export function isCancelled<R extends CheckinRecord>(record: CheckinRecord, states: ReadonlyMap<string, TicketState<R>>): boolean {
  if (record.op !== "checkin") return false;
  const state = stateOf(states, record.ticketToken);
  if (!state.done) return true;
  return !state.uncancelled.some((uncancelled) => uncancelled.recordId === record.recordId);
}

/**
 * 取り消しの記録が指す記録 ID の集合を、1 件の記録に入る数（50 件）ごとに分ける（Design Doc 4.4）。
 * 指すのは、そのチケットの打ち消されていないチェックインの記録すべてである。未のチケットでは空の配列を返す
 */
export function cancelTargetIdChunks(state: TicketState): string[][] {
  if (!state.done) return [];
  const ids = state.uncancelled.map((record) => record.recordId);
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += TARGET_RECORD_IDS_MAX) chunks.push(ids.slice(i, i + TARGET_RECORD_IDS_MAX));
  return chunks;
}

/** 記録に写す操作者（FR-38）。/api/me の応答と同じ形 */
export type RecordOperator = { operatorId: string; operatorName: string };

/** 記録に写すチケットの値。Ticket をそのまま渡せる */
export type RecordTicket = { ticketToken: string; userName: string; ticketNo: string };

export type CreateCheckinRecordsInput = {
  /** 済みにするチケット。判定の newlyDone（Design Doc 5.4） */
  tickets: readonly RecordTicket[];
  /** この操作の操作 ID */
  opId: string;
  /** 記録 ID を作る関数。記録 1 件につき 1 回呼ぶ（crypto.randomUUID など） */
  newRecordId: () => string;
  /** 判定した受付の id */
  reception: string;
  route: "qr" | "search";
  /** 端末の現在時刻 */
  deviceTime: number;
  deviceId: string;
  operator: RecordOperator;
};

/**
 * チェックインの記録を作る（Design Doc 4.4）。チケット 1 枚につき 1 件で、操作 ID と時刻は共通にする。
 * ユーザ名とチケット番号は、チケットの値を写す。作った記録の検証（checkinRecordSchema）は、呼び出し側が行う（Design Doc 4.1）
 */
export function createCheckinRecords(input: CreateCheckinRecordsInput): CheckinRecord[] {
  return input.tickets.map((ticket) => ({
    recordId: input.newRecordId(),
    opId: input.opId,
    op: "checkin",
    ticketToken: ticket.ticketToken,
    userName: ticket.userName,
    ticketNo: ticket.ticketNo,
    reception: input.reception,
    route: input.route,
    reasonKind: null,
    reasonText: null,
    targetRecordIds: null,
    deviceTime: input.deviceTime,
    deviceId: input.deviceId,
    operatorId: input.operator.operatorId,
    operatorName: input.operator.operatorName,
  }));
}

/** 取り消しの理由。自由記述は、区分が「その他」のときだけ持つ（FR-29） */
export type CancelReason = { kind: "mistake" | "wrong_person" } | { kind: "other"; text: string };

export type CreateCancelRecordsInput = {
  /**
   * 取り消しの操作に使ったチェックインの記録のうち、取り消すと選んだチケットの分（FR-29）。
   * チケットごとに 1 件。ユーザ名とチケット番号は、この記録の値を引き継ぐ（FR-39）
   */
  from: readonly CheckinRecord[];
  /** 確定した時点の集約（Design Doc 6.2） */
  states: ReadonlyMap<string, TicketState>;
  opId: string;
  /** 記録 ID を作る関数。作る記録 1 件につき 1 回呼ぶ。分割で件数が決まるので、ID の列ではなく関数で受ける */
  newRecordId: () => string;
  /** 確定している受付の id。受付なしのときは null */
  reception: string | null;
  reason: CancelReason;
  deviceTime: number;
  deviceId: string;
  operator: RecordOperator;
};

export type CreateCancelRecordsResult = {
  /** 作った取り消しの記録。すべてが根拠でなくなっていれば空 */
  records: CheckinRecord[];
  /** from のうち、確定した時点で根拠の記録でなくなっていて、取り消しの記録を作らなかったもの */
  skipped: CheckinRecord[];
};

/**
 * 取り消しの記録を作る（Design Doc 4.4、6.2、FR-29）。
 *
 * from の記録が、確定した時点でまだそのチケットの済みの根拠であれば、そのチケットの打ち消されていない
 * チェックインの記録（根拠の記録と、受け取っている重複のチェックイン）すべてを指す取り消しの記録を作る。
 * 指す ID が 50 件を超えるときは、同じ操作 ID で記録を分ける。根拠でなくなった記録には作らず、skipped に入れる
 */
export function createCancelRecords(input: CreateCancelRecordsInput): CreateCancelRecordsResult {
  const records: CheckinRecord[] = [];
  const skipped: CheckinRecord[] = [];
  for (const source of input.from) {
    if (source.op !== "checkin" || !isBasis(source, input.states)) {
      skipped.push(source);
      continue;
    }
    for (const targetRecordIds of cancelTargetIdChunks(stateOf(input.states, source.ticketToken))) {
      records.push({
        recordId: input.newRecordId(),
        opId: input.opId,
        op: "cancel",
        ticketToken: source.ticketToken,
        userName: source.userName,
        ticketNo: source.ticketNo,
        reception: input.reception,
        route: null,
        reasonKind: input.reason.kind,
        reasonText: input.reason.kind === "other" ? input.reason.text : null,
        targetRecordIds,
        deviceTime: input.deviceTime,
        deviceId: input.deviceId,
        operatorId: input.operator.operatorId,
        operatorName: input.operator.operatorName,
      });
    }
  }
  return { records, skipped };
}
