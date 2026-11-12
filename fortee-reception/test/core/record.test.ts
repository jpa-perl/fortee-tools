import { describe, expect, it } from "vitest";
import { checkinRecordSchema, serverRecordSchema } from "../../src/core/record.ts";

const checkin = {
  recordId: "9f1c2a3b-4d5e-4f60-8a7b-0c1d2e3f4a5b",
  opId: "3a7e2a3b-4d5e-4f60-8a7b-0c1d2e3f4a5b",
  op: "checkin",
  ticketToken: "aRZAnjQt1sepvZ2OTJLNQZ1MsAI93cAw",
  userName: "karupanerura",
  ticketNo: "A-12",
  reception: "eve",
  route: "qr",
  reasonKind: null,
  reasonText: null,
  targetRecordIds: null,
  deviceTime: 1764300000000,
  deviceId: "c2d42a3b-4d5e-4f60-8a7b-0c1d2e3f4a5b",
  operatorId: "123456789012345678",
  operatorName: "karupanerura",
};

const cancel = {
  ...checkin,
  recordId: "0a1b2c3d-4d5e-4f60-8a7b-0c1d2e3f4a5b",
  op: "cancel",
  route: null,
  reasonKind: "mistake",
  reasonText: null,
  targetRecordIds: [checkin.recordId],
};

const ok = (value: unknown) => checkinRecordSchema.safeParse(value).success;

describe("記録のスキーマ（Design Doc 4.4）", () => {
  it("チェックインと取り消しの記録を通す", () => {
    expect(ok(checkin)).toBe(true);
    expect(ok(cancel)).toBe(true);
  });

  it("検索からのチェックインを通す", () => {
    expect(ok({ ...checkin, route: "search" })).toBe(true);
  });

  it("知らない項目を落とす", () => {
    const parsed = checkinRecordSchema.parse({ ...checkin, extra: "x" });
    expect(parsed).toEqual(checkin);
  });

  it.each([
    ["チェックインに取り消しの項目がある", { ...checkin, reasonKind: "mistake" }],
    ["チェックインが打ち消す記録を持つ", { ...checkin, targetRecordIds: [cancel.recordId] }],
    ["チェックインの経路がない", { ...checkin, route: null }],
    ["チェックインの受付がない", { ...checkin, reception: null }],
    ["取り消しが経路を持つ", { ...cancel, route: "qr" }],
    ["取り消しが打ち消す記録を持たない", { ...cancel, targetRecordIds: null }],
    ["打ち消す記録が 0 件", { ...cancel, targetRecordIds: [] }],
    ["打ち消す記録に重複がある", { ...cancel, targetRecordIds: [checkin.recordId, checkin.recordId] }],
    ["打ち消す記録が UUID の形でない", { ...cancel, targetRecordIds: ["x"] }],
    ["知らない操作", { ...checkin, op: "undo" }],
    ["知らない理由の区分", { ...cancel, reasonKind: "typo" }],
    ["その他なのに自由記述がない", { ...cancel, reasonKind: "other", reasonText: null }],
    ["その他でないのに自由記述がある", { ...cancel, reasonKind: "mistake", reasonText: "x" }],
    ["記録 ID が UUID の形でない", { ...checkin, recordId: "not-a-uuid" }],
    ["記録 ID が大文字", { ...checkin, recordId: checkin.recordId.toUpperCase() }],
    ["チケットトークンが 32 文字でない", { ...checkin, ticketToken: "abc" }],
    ["受付の id に使えない文字がある", { ...checkin, reception: "前夜祭" }],
    ["受付の id が 33 文字", { ...checkin, reception: "a".repeat(33) }],
    ["操作者 ID が数字でない", { ...checkin, operatorId: "abc" }],
    ["端末の時刻が整数でない", { ...checkin, deviceTime: 1.5 }],
  ])("%s記録を拒む", (_name, value) => {
    expect(ok(value)).toBe(false);
  });

  it("受付なしのときの取り消しを通す", () => {
    expect(ok({ ...cancel, reception: null })).toBe(true);
  });

  it("その他の取り消しは自由記述を持つ", () => {
    expect(ok({ ...cancel, reasonKind: "other", reasonText: "二重に読み取った" })).toBe(true);
  });

  it("上限ちょうどは通し、超えると拒む（Design Doc 7.3）", () => {
    expect(ok({ ...checkin, userName: "u".repeat(100) })).toBe(true);
    expect(ok({ ...checkin, userName: "u".repeat(101) })).toBe(false);
    expect(ok({ ...checkin, ticketNo: "n".repeat(101) })).toBe(false);
    expect(ok({ ...checkin, operatorName: "o".repeat(101) })).toBe(false);

    const other = { ...cancel, reasonKind: "other" };
    expect(ok({ ...other, reasonText: "r".repeat(2000) })).toBe(true);
    expect(ok({ ...other, reasonText: "r".repeat(2001) })).toBe(false);

    const ids = (n: number) =>
      Array.from({ length: n }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
    expect(ok({ ...cancel, targetRecordIds: ids(50) })).toBe(true);
    expect(ok({ ...cancel, targetRecordIds: ids(51) })).toBe(false);
  });
});

describe("サーバが返す記録のスキーマ", () => {
  it("連番と受信時刻を持つ記録を通す", () => {
    const record = { ...checkin, seq: 1, receivedAt: 1764300000123 };
    expect(serverRecordSchema.parse(record)).toEqual(record);
    expect(serverRecordSchema.safeParse({ ...cancel, seq: 2, receivedAt: 1764300000456 }).success).toBe(true);
  });

  it("連番と受信時刻のない記録を拒む", () => {
    expect(serverRecordSchema.safeParse(checkin).success).toBe(false);
    expect(serverRecordSchema.safeParse({ ...checkin, seq: 0, receivedAt: 1 }).success).toBe(false);
  });
});
