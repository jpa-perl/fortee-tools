import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { DATABASE_NAME, ensureDeviceId, openDatabase, type StoredRecord } from "../../src/app/storage/db.ts";

// storage は fake-indexeddb で確かめる（Design Doc 11 章）

describe("端末内の記憶域（Design Doc 6.3）", () => {
  it("4 つのストアを作る", async () => {
    const db = await openDatabase();
    expect(db.name).toBe(DATABASE_NAME);
    expect([...db.objectStoreNames].sort()).toEqual(["config", "meta", "records", "snapshots"]);
    db.close();
  });

  it("端末 ID を初回に生成し、開き直しても同じ値を返す", async () => {
    const db = await openDatabase();
    const deviceId = await ensureDeviceId(db);
    expect(deviceId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(await ensureDeviceId(db)).toBe(deviceId);
    db.close();

    const reopened = await openDatabase();
    expect(await ensureDeviceId(reopened)).toBe(deviceId);
    reopened.close();
  });

  it("記録を記録 ID で置く", async () => {
    const record: StoredRecord = {
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
      sent: false,
      seq: null,
      receivedAt: null,
    };
    const db = await openDatabase();
    await db.put("records", record);
    await db.put("records", { ...record, sent: true, seq: 1, receivedAt: 1764300000123 });
    expect(await db.getAll("records")).toEqual([{ ...record, sent: true, seq: 1, receivedAt: 1764300000123 }]);
    db.close();
  });
});
