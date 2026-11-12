import { describe, expect, it } from "vitest";
import { checkinRecordSchema, TARGET_RECORD_IDS_MAX } from "../../src/core/record.ts";
import {
  aggregate,
  cancelTargetIdChunks,
  compareRecords,
  createCancelRecords,
  createCheckinRecords,
  isBasis,
  isCancelled,
  type OrderedRecord,
  stateOf,
} from "../../src/core/records.ts";
import { cancel, checkin, DEVICE_A, DEVICE_B, MAIN, ticket, token, uuid } from "./helpers.ts";

const T1 = token(9001);
const T2 = token(9002);

/** 配列のすべての並べ替え */
function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [[...items]];
  return items.flatMap((item, i) =>
    permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest]),
  );
}

/** 集約の結果を、比べやすい形にする */
const summary = (records: Iterable<OrderedRecord>, ticketToken = T1) => {
  const state = stateOf(aggregate(records), ticketToken);
  return {
    done: state.done,
    basis: state.done ? state.basis.recordId : null,
    uncancelled: state.done ? state.uncancelled.map((record) => record.recordId) : [],
    lastCancel: state.lastCancel?.recordId ?? null,
  };
};

/** 記録の並びを入れ替えても、結果が同じであること */
function expectOrderIndependent(records: readonly OrderedRecord[], ticketToken = T1) {
  const expected = summary(records, ticketToken);
  for (const order of permutations(records)) expect(summary(order, ticketToken)).toEqual(expected);
}

describe("記録の順序（Design Doc 5.3）", () => {
  it("端末の時刻、サーバの受信時刻、記録 ID の順で決める", () => {
    const early = checkin(2, T1, 1000, { receivedAt: 9000 });
    const late = checkin(1, T1, 2000, { receivedAt: 5000 });
    expect(compareRecords(early, late)).toBeLessThan(0);
    expect(compareRecords(late, early)).toBeGreaterThan(0);

    const receivedFirst = checkin(2, T1, 1000, { receivedAt: 5000 });
    const receivedLater = checkin(1, T1, 1000, { receivedAt: 6000 });
    expect(compareRecords(receivedFirst, receivedLater)).toBeLessThan(0);

    const idSmall = checkin(1, T1, 1000, { receivedAt: 5000 });
    const idLarge = checkin(2, T1, 1000, { receivedAt: 5000 });
    expect(compareRecords(idSmall, idLarge)).toBeLessThan(0);
    expect(compareRecords(idSmall, idSmall)).toBe(0);
  });

  it("受信時刻のない記録は、同じ端末時刻の中では、受信時刻のある記録の後ろに置く", () => {
    const received = checkin(2, T1, 1000, { receivedAt: 9000 });
    const unsent = checkin(1, T1, 1000);
    const unsentNull = checkin(3, T1, 1000, { receivedAt: null });
    expect(compareRecords(received, unsent)).toBeLessThan(0);
    expect(compareRecords(unsent, received)).toBeGreaterThan(0);
    // 受信時刻のない記録どうしは、記録 ID の順
    expect(compareRecords(unsent, unsentNull)).toBeLessThan(0);
    // 端末の時刻が早ければ、受信時刻がなくても先
    expect(compareRecords(checkin(4, T1, 999), received)).toBeLessThan(0);
  });
});

describe("記録の集約（PRD 7.2、Design Doc 5.3）", () => {
  it("記録のないチケットは未", () => {
    expect(summary([])).toEqual({ done: false, basis: null, uncancelled: [], lastCancel: null });
    expect(aggregate([]).size).toBe(0);
  });

  it("チェックインの記録があれば済みで、その記録が根拠になる", () => {
    expect(summary([checkin(1, T1, 1000)])).toEqual({ done: true, basis: uuid(1), uncancelled: [uuid(1)], lastCancel: null });
  });

  it("チケットごとに集約する", () => {
    const records = [checkin(1, T1, 1000), checkin(2, T2, 2000), cancel(3, T2, 3000, [2])];
    expect(summary(records, T1).done).toBe(true);
    expect(summary(records, T2)).toEqual({ done: false, basis: null, uncancelled: [], lastCancel: uuid(3) });
  });

  it("取り消しの記録が指すチェックインは打ち消され、未になる", () => {
    const records = [checkin(1, T1, 1000), cancel(2, T1, 2000, [1])];
    expect(summary(records)).toEqual({ done: false, basis: null, uncancelled: [], lastCancel: uuid(2) });
    expectOrderIndependent(records);
  });

  it("取り消した後に再チェックインすると済みで、両方の記録が残る（FR-30）", () => {
    const records = [checkin(1, T1, 1000), cancel(2, T1, 2000, [1]), checkin(3, T1, 3000)];
    expect(summary(records)).toEqual({ done: true, basis: uuid(3), uncancelled: [uuid(3)], lastCancel: uuid(2) });
    expectOrderIndependent(records);
  });

  it("複数端末でチェックインされたチケットは、時刻の早い記録を採用する（FR-41）", () => {
    const records = [
      checkin(1, T1, 2000, { deviceId: DEVICE_A, receivedAt: 5000 }),
      checkin(2, T1, 1000, { deviceId: DEVICE_B, receivedAt: 9000 }),
    ];
    expect(summary(records)).toEqual({ done: true, basis: uuid(2), uncancelled: [uuid(2), uuid(1)], lastCancel: null });
    expectOrderIndependent(records);
  });

  it("同時刻のチェックインは、サーバの受信時刻の早い記録を採用する", () => {
    const records = [
      checkin(1, T1, 1000, { deviceId: DEVICE_A, receivedAt: 9000 }),
      checkin(2, T1, 1000, { deviceId: DEVICE_B, receivedAt: 5000 }),
    ];
    expect(summary(records).basis).toBe(uuid(2));
    expectOrderIndependent(records);
  });

  it("受信していない再チェックインは、古い記録からの取り消しで打ち消されない", () => {
    // 端末 A と B が C1 を持つ。B が C1 を取り消して C2 で再チェックインした後に、
    // B の記録を持たない A が C1 を取り消す
    const c1 = checkin(1, T1, 1000, { deviceId: DEVICE_A });
    const cancelByB = cancel(2, T1, 2000, [1], { deviceId: DEVICE_B });
    const c2 = checkin(3, T1, 3000, { deviceId: DEVICE_B });
    const cancelByA = cancel(4, T1, 4000, [1], { deviceId: DEVICE_A });

    // A の手元（B の記録を受信していない）では未
    expect(summary([c1, cancelByA]).done).toBe(false);
    // 合流した後も、C2 を根拠に済みである。A の取り消しは C2 より後の時刻だが、C2 を指していない
    const merged = [c1, cancelByB, c2, cancelByA];
    expect(summary(merged)).toEqual({ done: true, basis: uuid(3), uncancelled: [uuid(3)], lastCancel: uuid(4) });
    expectOrderIndependent(merged);
  });

  it("時計の遅れた端末の取り消しは、端末時刻が指すチェックインより前でも、指した記録を打ち消す", () => {
    const records = [
      checkin(1, T1, 5000, { deviceId: DEVICE_A }),
      cancel(2, T1, 1000, [1], { deviceId: DEVICE_B }),
    ];
    expect(summary(records)).toEqual({ done: false, basis: null, uncancelled: [], lastCancel: uuid(2) });
    expectOrderIndependent(records);
  });

  it("取り消した端末が持っていなかった別端末のチェックイン（FR-41 の重複）は打ち消されず、合流の後に済みになる", () => {
    const byA = checkin(1, T1, 1000, { deviceId: DEVICE_A });
    const byB = checkin(2, T1, 1500, { deviceId: DEVICE_B });
    // A は、B のチェックインを受信しないまま、自分のチェックインを取り消す
    const cancelByA = cancel(3, T1, 2000, [1], { deviceId: DEVICE_A });

    expect(summary([byA, cancelByA]).done).toBe(false);
    const merged = [byA, byB, cancelByA];
    expect(summary(merged)).toEqual({ done: true, basis: uuid(2), uncancelled: [uuid(2)], lastCancel: uuid(3) });
    expectOrderIndependent(merged);
  });

  it("受け取っている重複のチェックインは、取り消しの記録がすべてを指すので、まとめて打ち消される", () => {
    const records = [
      checkin(1, T1, 1000, { deviceId: DEVICE_A }),
      checkin(2, T1, 1500, { deviceId: DEVICE_B }),
      cancel(3, T1, 2000, [1, 2]),
    ];
    expect(summary(records).done).toBe(false);
    expectOrderIndependent(records);
  });

  it("取り消しの記録が、指す先のチェックインより先に届いても、結果は同じ", () => {
    const first = [cancel(2, T1, 2000, [1]), checkin(1, T1, 1000)];
    const second = [checkin(1, T1, 1000), cancel(2, T1, 2000, [1])];
    expect(summary(first)).toEqual(summary(second));
    // まだ届いていないチェックインを指す取り消しだけがあるときは未で、届いた時点で打ち消される
    expect(summary([cancel(2, T1, 2000, [1])])).toEqual({ done: false, basis: null, uncancelled: [], lastCancel: uuid(2) });
  });

  it("ほかのチケットの記録、取り消しの記録、存在しない記録を指す ID は無視する", () => {
    const records = [
      checkin(1, T1, 1000),
      checkin(2, T2, 1000),
      // T2 の取り消しが、T1 のチェックインを指す
      cancel(3, T2, 2000, [1]),
      // T1 の取り消しが、T2 のチェックイン、取り消しの記録、存在しない記録を指す
      cancel(4, T1, 3000, [2, 3, 999]),
    ];
    expect(summary(records, T1)).toEqual({ done: true, basis: uuid(1), uncancelled: [uuid(1)], lastCancel: uuid(4) });
    expect(summary(records, T2)).toEqual({ done: true, basis: uuid(2), uncancelled: [uuid(2)], lastCancel: uuid(3) });
    expectOrderIndependent(records, T1);
    expectOrderIndependent(records, T2);
  });

  it("同じ操作 ID で複数に分けた取り消しの記録が、合わせて 50 件を超えるチェックインを打ち消す", () => {
    const count = TARGET_RECORD_IDS_MAX + 10;
    const checkins = Array.from({ length: count }, (_, i) => checkin(100 + i, T1, 1000 + i));
    const opId = uuid(0x7777);
    const targets = checkins.map((_, i) => 100 + i);
    const first = cancel(1, T1, 5000, targets.slice(0, TARGET_RECORD_IDS_MAX), { opId });
    const second = cancel(2, T1, 5000, targets.slice(TARGET_RECORD_IDS_MAX), { opId });

    expect(checkinRecordSchema.safeParse(first).success).toBe(true);
    expect(checkinRecordSchema.safeParse(second).success).toBe(true);
    // 片方だけでは、指されていない 10 件が残る
    expect(summary([...checkins, first]).uncancelled).toHaveLength(10);
    expect(summary([...checkins, first, second]).done).toBe(false);
    expect(summary([second, ...checkins.toReversed(), first]).done).toBe(false);
  });

  it("lastCancel は、取り消しの記録のうち最も遅いもの", () => {
    const records = [
      checkin(1, T1, 1000),
      cancel(2, T1, 2000, [1]),
      checkin(3, T1, 3000),
      cancel(4, T1, 4000, [3]),
      checkin(5, T1, 5000),
    ];
    expect(summary(records)).toEqual({ done: true, basis: uuid(5), uncancelled: [uuid(5)], lastCancel: uuid(4) });
    expectOrderIndependent(records);
  });

  it("同じ記録 ID の記録は 1 件として扱う", () => {
    const record = checkin(1, T1, 1000);
    expect(summary([record, { ...record }]).uncancelled).toEqual([uuid(1)]);
  });
});

describe("打ち消されているか、根拠か（Design Doc 5.3、画面設計書 S08）", () => {
  const c1 = checkin(1, T1, 1000);
  const c2 = checkin(2, T1, 2000, { deviceId: DEVICE_B });
  const c3 = checkin(3, T1, 3000);
  const x1 = cancel(4, T1, 1500, [1]);
  const states = aggregate([c1, c2, c3, x1]);

  it("済みのチケットでは、uncancelled にない記録が打ち消されている", () => {
    expect(isCancelled(c1, states)).toBe(true);
    expect(isCancelled(c2, states)).toBe(false);
    expect(isCancelled(c3, states)).toBe(false);
    expect(isCancelled(x1, states)).toBe(false);
  });

  it("根拠は、打ち消されていない最も早い記録だけ", () => {
    expect(isBasis(c1, states)).toBe(false);
    expect(isBasis(c2, states)).toBe(true);
    expect(isBasis(c3, states)).toBe(false);
  });

  it("未のチケットでは、すべてのチェックインの記録が打ち消されている", () => {
    const undone = aggregate([c1, x1]);
    expect(isCancelled(c1, undone)).toBe(true);
    expect(isBasis(c1, undone)).toBe(false);
  });
});

describe("記録を作る（Design Doc 4.4）", () => {
  const operator = { operatorId: "123456789012345678", operatorName: "受付 太郎" };
  const ids = (start: number) => {
    let next = start;
    return () => uuid(next++);
  };

  it("チェックインの記録を、チケット 1 枚につき 1 件作り、ユーザ名とチケット番号を写す", () => {
    const tickets = [
      ticket({ eventId: MAIN, userName: "alice", ticketNo: "A-1" }),
      ticket({ eventId: MAIN, userName: "alice", ticketNo: "E-1" }),
    ];
    const records = createCheckinRecords({
      tickets,
      opId: uuid(0x99),
      newRecordId: ids(1),
      reception: "eve",
      route: "search",
      deviceTime: 1764300000000,
      deviceId: DEVICE_A,
      operator,
    });
    expect(records).toHaveLength(2);
    expect(records[0]).toEqual({
      recordId: uuid(1),
      opId: uuid(0x99),
      op: "checkin",
      ticketToken: tickets[0]?.ticketToken,
      userName: "alice",
      ticketNo: "A-1",
      reception: "eve",
      route: "search",
      reasonKind: null,
      reasonText: null,
      targetRecordIds: null,
      deviceTime: 1764300000000,
      deviceId: DEVICE_A,
      operatorId: "123456789012345678",
      operatorName: "受付 太郎",
    });
    expect(records[1]?.recordId).toBe(uuid(2));
    expect(records[1]?.ticketNo).toBe("E-1");
    for (const record of records) expect(checkinRecordSchema.safeParse(record).success).toBe(true);
  });

  const cancelInput = (from: OrderedRecord[], all: OrderedRecord[]) => ({
    from,
    states: aggregate(all),
    opId: uuid(0x98),
    newRecordId: ids(500),
    reception: null,
    reason: { kind: "other", text: "別の人のチケットだった" } as const,
    deviceTime: 1764300009000,
    deviceId: DEVICE_B,
    operator,
  });

  it("取り消しの記録は、そのチケットの打ち消されていないチェックインすべてを指し、根拠の記録の値を引き継ぐ", () => {
    const basis = checkin(1, T1, 1000, { userName: "alice", ticketNo: "A-1" });
    const duplicate = checkin(2, T1, 2000, { deviceId: DEVICE_B, userName: "alice-renamed", ticketNo: "A-1" });
    const old = checkin(3, T1, 500);
    const oldCancel = cancel(4, T1, 600, [3]);
    const { records, skipped } = createCancelRecords(cancelInput([basis], [basis, duplicate, old, oldCancel]));

    expect(skipped).toEqual([]);
    expect(records).toEqual([
      {
        recordId: uuid(500),
        opId: uuid(0x98),
        op: "cancel",
        ticketToken: T1,
        userName: "alice",
        ticketNo: "A-1",
        reception: null,
        route: null,
        reasonKind: "other",
        reasonText: "別の人のチケットだった",
        targetRecordIds: [uuid(1), uuid(2)],
        deviceTime: 1764300009000,
        deviceId: DEVICE_B,
        operatorId: "123456789012345678",
        operatorName: "受付 太郎",
      },
    ]);
    expect(checkinRecordSchema.safeParse(records[0]).success).toBe(true);
    // 作った記録を加えると、未になる
    expect(summary([basis, duplicate, old, oldCancel, ...records]).done).toBe(false);
  });

  it("区分が「その他」でなければ、自由記述を持たない", () => {
    const basis = checkin(1, T1, 1000);
    const { records } = createCancelRecords({ ...cancelInput([basis], [basis]), reason: { kind: "mistake" }, reception: "main" });
    expect(records[0]).toMatchObject({ reasonKind: "mistake", reasonText: null, reception: "main" });
    expect(checkinRecordSchema.safeParse(records[0]).success).toBe(true);
  });

  it("確定した時点で根拠でなくなった記録には、取り消しの記録を作らない（FR-29）", () => {
    // 確認を開いた後に、他端末の「取り消して再チェックイン」が届いた
    const c1 = checkin(1, T1, 1000);
    const otherCancel = cancel(2, T1, 2000, [1], { deviceId: DEVICE_B });
    const c2 = checkin(3, T1, 3000, { deviceId: DEVICE_B });
    const other = checkin(4, T2, 1000);
    const { records, skipped } = createCancelRecords(cancelInput([c1, other], [c1, otherCancel, c2, other]));

    expect(skipped).toEqual([c1]);
    // 根拠のままの T2 だけを取り消し、届いた再チェックイン（C2）は指さない
    expect(records.map((record) => [record.ticketToken, record.targetRecordIds])).toEqual([[T2, [uuid(4)]]]);
  });

  it("すべてが根拠でなくなっていれば、記録を作らない", () => {
    const c1 = checkin(1, T1, 1000);
    const { records, skipped } = createCancelRecords(cancelInput([c1], [c1, cancel(2, T1, 2000, [1])]));
    expect(records).toEqual([]);
    expect(skipped).toEqual([c1]);
  });

  it("指す記録が 50 件を超えるときは、同じ操作 ID で記録を分ける", () => {
    const count = TARGET_RECORD_IDS_MAX * 2 + 1;
    const checkins = Array.from({ length: count }, (_, i) => checkin(100 + i, T1, 1000 + i));
    const states = aggregate(checkins);
    expect(cancelTargetIdChunks(stateOf(states, T1)).map((chunk) => chunk.length)).toEqual([50, 50, 1]);
    expect(cancelTargetIdChunks(stateOf(states, T2))).toEqual([]);

    const { records } = createCancelRecords(cancelInput([checkins[0] as OrderedRecord], checkins));
    expect(records).toHaveLength(3);
    expect(new Set(records.map((record) => record.opId)).size).toBe(1);
    expect(new Set(records.map((record) => record.recordId)).size).toBe(3);
    for (const record of records) expect(checkinRecordSchema.safeParse(record).success).toBe(true);
    expect(summary([...checkins, ...records]).done).toBe(false);
  });
});
