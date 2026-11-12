import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it } from "vitest";
import {
  addRecords,
  clearForLogout,
  type Database,
  DATABASE_NAME,
  LEGACY_DATABASE_NAMES,
  openDatabase,
  readData,
  readMeta,
  replaceDistribution,
  resetGeneration,
  type StoredRecord,
  writeMeta,
  writeSyncResult,
} from "../../src/app/storage/db.ts";
import type { ServerRecord } from "../../src/core/record.ts";
import { checkin, config, EVE, MAIN, snapshotsOf, ticket, token, uuid } from "../core/helpers.ts";

// storage は fake-indexeddb で確かめる（Design Doc 11 章）

const stored = (id: number, fields: Partial<StoredRecord> = {}): StoredRecord =>
  ({ ...checkin(id, token(id), 1_764_300_000_000 + id), sent: false, seq: null, receivedAt: null, ...fields }) as StoredRecord;

async function open(): Promise<Database> {
  const result = await openDatabase();
  if (result.kind !== "ok") throw new Error("開けない");
  return result.db;
}

let nextId = 0;
const newId = () => uuid(0x9000 + nextId++);

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
});

describe("端末内の記憶域（Design Doc 6.3）", () => {
  it("4 つのストアを作る", async () => {
    const db = await open();
    expect(db.name).toBe(DATABASE_NAME);
    expect([...db.objectStoreNames].sort()).toEqual(["config", "meta", "records", "snapshots"]);
    db.close();
  });

  it("前の名前のデータベースが残っていれば、読まずに消す", async () => {
    for (const name of LEGACY_DATABASE_NAMES) {
      await new Promise<void>((resolve, reject) => {
        const request = indexedDB.open(name, 1);
        request.onupgradeneeded = () => request.result.createObjectStore("records", { keyPath: "recordId" });
        request.onsuccess = () => {
          request.result.close();
          resolve();
        };
        request.onerror = () => reject(request.error);
      });
    }
    const db = await open();
    await expect.poll(async () => (await indexedDB.databases()).map((found) => found.name)).toEqual([DATABASE_NAME]);
    db.close();
  });

  it("端末 ID を初回に生成し、開き直しても同じ値を返す。ほかの項目は既定の値になる", async () => {
    const db = await open();
    const meta = await readMeta(db, newId);
    expect(meta).toEqual({
      deviceId: meta.deviceId,
      operator: null,
      sound: true,
      vibration: true,
      cursor: null,
      override: null,
      lastSyncAt: null,
      loginEpoch: 0,
    });
    db.close();

    const reopened = await open();
    expect((await readMeta(reopened, newId)).deviceId).toBe(meta.deviceId);
    reopened.close();
  });

  it("1 回の操作で作った記録は、一体に書く。1 件でも書けなければ、どれも残らない", async () => {
    const db = await open();
    await addRecords(db, [stored(1)]);
    await expect(addRecords(db, [stored(2), stored(1)])).rejects.toThrow();
    expect((await readData(db)).records.map((record) => record.recordId)).toEqual([uuid(1)]);
    db.close();
  });

  it("同期の 1 要求の結果は、sent の印、合流、受信位置を一体に書く", async () => {
    const db = await open();
    await addRecords(db, [stored(1), stored(2)]);
    const mine = { ...checkin(1, token(1), 1_764_300_000_001), seq: 7, receivedAt: 5000 } as ServerRecord;
    const other = { ...checkin(3, token(3), 1_764_300_000_003), seq: 8, receivedAt: 5001 } as ServerRecord;
    const changed = await writeSyncResult(db, {
      sentRecordIds: [uuid(1)],
      received: [mine, other],
      cursor: { generation: "g", seq: 8 },
    });
    expect(changed).toHaveLength(2);
    const records = new Map((await readData(db)).records.map((record) => [record.recordId, record]));
    // 送った記録には sent が付き、応答に含まれていれば seq と receivedAt も書く
    expect(records.get(uuid(1))).toMatchObject({ sent: true, seq: 7, receivedAt: 5000 });
    // 要求に載せていない記録には、sent を付けない
    expect(records.get(uuid(2))).toMatchObject({ sent: false, seq: null });
    // 受け取った他端末の記録
    expect(records.get(uuid(3))).toMatchObject({ sent: true, seq: 8, receivedAt: 5001 });
    expect((await readMeta(db, newId)).cursor).toEqual({ generation: "g", seq: 8 });
    db.close();
  });

  it("世代の変化では、すべての記録の sent を偽、seq を null にし、receivedAt は残す", async () => {
    const db = await open();
    await addRecords(db, [stored(1, { sent: true, seq: 3, receivedAt: 5000 }), stored(2)]);
    await resetGeneration(db, { generation: "g2", seq: 0 });
    const records = (await readData(db)).records;
    expect(records.every((record) => !record.sent && record.seq === null)).toBe(true);
    expect(records.find((record) => record.recordId === uuid(1))?.receivedAt).toBe(5000);
    expect((await readMeta(db, newId)).cursor).toEqual({ generation: "g2", seq: 0 });
    db.close();
  });

  it("配布物の差し替えは、config と snapshots の全部を一体に書き、応答にないイベントを消す", async () => {
    const db = await open();
    const first = snapshotsOf([ticket({ eventId: MAIN, userName: "a" }), ticket({ eventId: EVE, userName: "a" })]);
    await writeMeta(db, "override", { receptionId: "eve", until: null });
    await replaceDistribution(db, config, first, { clearOverride: false });
    expect((await readData(db)).snapshots).toHaveLength(2);
    expect((await readMeta(db, newId)).override).toEqual({ receptionId: "eve", until: null });

    const next = { ...config, version: config.version + 1 };
    await replaceDistribution(db, next, first.slice(0, 1), { clearOverride: true });
    const data = await readData(db);
    expect(data.config?.version).toBe(next.version);
    expect(data.snapshots.map((snapshot) => snapshot.eventId)).toEqual([MAIN]);
    expect((await readMeta(db, newId)).override).toBeNull();
    db.close();
  });

  it("ログアウトでは、端末 ID、音と振動の設定、ログインの番号を除いて、すべて消す", async () => {
    const db = await open();
    const { deviceId } = await readMeta(db, newId);
    await writeMeta(db, "operator", { operatorId: "1", operatorName: "staff" });
    await writeMeta(db, "sound", false);
    await writeMeta(db, "cursor", { generation: "g", seq: 1 });
    await writeMeta(db, "lastSyncAt", 1);
    await replaceDistribution(db, config, snapshotsOf([ticket({ eventId: MAIN, userName: "a" })]), { clearOverride: false });
    await addRecords(db, [stored(1)]);

    await clearForLogout(db, 3);
    expect(await readMeta(db, newId)).toEqual({
      deviceId,
      operator: null,
      sound: false,
      vibration: true,
      cursor: null,
      override: null,
      lastSyncAt: null,
      loginEpoch: 3,
    });
    expect(await readData(db)).toEqual({ config: null, snapshots: [], records: [] });
    db.close();
  });

  it("形の合わない値を読んだら、例外を投げる（呼び出し側が S99 に移す）", async () => {
    const db = await open();
    await addRecords(db, [{ ...stored(1), op: "unknown" } as unknown as StoredRecord]);
    await expect(readData(db)).rejects.toThrow();
    await writeMeta(db, "cursor", { generation: 1 } as never);
    await expect(readMeta(db, newId)).rejects.toThrow();
    db.close();
  });
});

describe("版を上げる要求と、ほかの画面の接続の重なり（Design Doc 6.3）", () => {
  it("接続を持つ画面は versionchange を知らされ、開こうとした画面は blocked を受けて、待たずに戻る", async () => {
    let blocking = 0;
    const holder = await openDatabase({ onBlocking: () => blocking++ });
    if (holder.kind !== "ok") throw new Error("開けない");

    const opener = await openDatabase({ version: 2, timeoutMs: 5000 });
    expect(opener.kind).toBe("blocked");
    expect(blocking).toBe(1);

    // 接続を持つ画面が閉じた後に、捨てたはずの要求が通っても、その接続はすぐに閉じる。
    // 残っていれば、次の版上げが待たされる
    holder.db.close();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const next = indexedDB.open(DATABASE_NAME, 3);
    const outcome = await new Promise<string>((resolve) => {
      next.onsuccess = () => resolve("ok");
      next.onblocked = () => resolve("blocked");
    });
    expect(outcome).toBe("ok");
    next.result.close();
  });

  it("blocked が届かなくても、移行が始まらないまま時間が過ぎたら、待たずに戻る", async () => {
    // 背景で凍結された画面が versionchange を処理せず、blocked も届かない場合。開く要求が、何も知らせない
    const real = indexedDB.open.bind(indexedDB);
    indexedDB.open = () => new IDBOpenDBRequest();
    try {
      const started = Date.now();
      expect(await openDatabase({ timeoutMs: 50 })).toEqual({ kind: "blocked" });
      expect(Date.now() - started).toBeGreaterThanOrEqual(40);
    } finally {
      indexedDB.open = real;
    }
  });
});
