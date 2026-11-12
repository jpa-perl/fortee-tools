import { describe, expect, it } from "vitest";
import { meResponseSchema, syncRequestSchema, syncResponseSchema } from "../../src/core/sync.ts";
import { SYNC_PROTOCOL_VERSION } from "../../src/core/versions.ts";

const record = {
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

const request = {
  v: SYNC_PROTOCOL_VERSION,
  deviceId: record.deviceId,
  deviceTime: 1764300000000,
  appVersion: "v1.2.0",
  cursor: { generation: "k7Qm", seq: 1234 },
  records: [record],
};

const requestOk = (value: unknown) => syncRequestSchema.safeParse(value).success;

describe("同期の要求のスキーマ（Design Doc 4.5）", () => {
  it("要求を通し、limit は省略できる", () => {
    expect(syncRequestSchema.parse(request).limit).toBeUndefined();
    expect(requestOk({ ...request, limit: 200 })).toBe(true);
  });

  it("初回は受信位置が null", () => {
    expect(requestOk({ ...request, cursor: null })).toBe(true);
  });

  it("知らない版を拒む", () => {
    expect(requestOk({ ...request, v: SYNC_PROTOCOL_VERSION + 1 })).toBe(false);
    expect(requestOk({ ...request, v: undefined })).toBe(false);
  });

  it("上限を超える要求を拒む（Design Doc 7.3）", () => {
    const records = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        ...record,
        recordId: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
      }));
    expect(requestOk({ ...request, records: records(50) })).toBe(true);
    expect(requestOk({ ...request, records: records(51) })).toBe(false);
    expect(requestOk({ ...request, limit: 0 })).toBe(false);
    expect(requestOk({ ...request, limit: 201 })).toBe(false);
    expect(requestOk({ ...request, appVersion: "v".repeat(64) })).toBe(true);
    expect(requestOk({ ...request, appVersion: "v".repeat(65) })).toBe(false);
  });

  it("形の合わない記録が 1 件でもあれば、要求の全体を拒む", () => {
    expect(requestOk({ ...request, records: [record, { ...record, op: "undo" }] })).toBe(false);
  });
});

describe("同期の応答のスキーマ（Design Doc 4.5）", () => {
  const response = {
    generation: "k7Qm",
    nextSeq: 1300,
    hasMore: false,
    records: [{ ...record, seq: 1300, receivedAt: 1764300000123 }],
    versions: { config: 1764100000000, events: { "8b2e79c9-9301-4dca-ac12-7b686a1ec85e": 1764200000000 } },
  };

  it("応答を通す", () => {
    expect(syncResponseSchema.parse(response)).toEqual(response);
  });

  it("まだ公開していなければ versions は null", () => {
    expect(syncResponseSchema.safeParse({ ...response, versions: null }).success).toBe(true);
  });

  it("知らない項目を落として読む（Design Doc 9.6）", () => {
    const parsed = syncResponseSchema.parse({ ...response, added: 1 });
    expect(parsed).toEqual(response);
  });
});

describe("/api/me の応答のスキーマ", () => {
  it("操作者を通す", () => {
    const me = { operatorId: "123456789012345678", operatorName: "karupanerura" };
    expect(meResponseSchema.parse(me)).toEqual(me);
  });
});
