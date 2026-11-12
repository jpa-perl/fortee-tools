import { type DBSchema, type IDBPDatabase, openDB } from "idb";
import type { PublishedConfig } from "../../core/config.ts";
import type { CheckinRecord } from "../../core/record.ts";
import type { Snapshot } from "../../core/snapshot.ts";

// 端末内の記憶域（Design Doc 6.3）。idb の呼び出しは、storage に閉じる。
// ストアに索引は置かない。記録もスナップショットも、起動時に全件をメモリに読む。
//
// まだないもの: ほかの画面との重なり（versionchange、blocked、terminated）の扱い、
// 一体に行う書き込み、ログアウトでの消去。起動とロックの流れ（Design Doc 6.4）とともに足す。

/**
 * データベースの名前。v1 より前（開発期間）の名前で、v1 では新しい名前（checkin）で作り、
 * この名前のデータベースは読まずに消す（Design Doc 9.6）
 */
export const DATABASE_NAME = "checkin-dev";

/** 端末の記憶域の版（Design Doc 9.5）。v1 で 1 から数え直す */
export const DATABASE_VERSION = 1;

/** 端末に置く記録。記録に、送信済みの印と、サーバから受け取った連番と受信時刻を加えたもの */
export type StoredRecord = CheckinRecord & {
  /** サーバが 200 を返した要求に含めたか。偽の記録が、未送信の記録である */
  sent: boolean;
  /** サーバから受け取るまでは null */
  seq: number | null;
  receivedAt: number | null;
};

interface CheckinDB extends DBSchema {
  /** 永続の状態の各項目（Design Doc 6.2）。キーは項目名 */
  meta: { key: string; value: unknown };
  /** 公開された設定。固定の 1 件 */
  config: { key: "current"; value: PublishedConfig };
  /** イベントごとのスナップショット。1 件を 1 つの値として置く */
  snapshots: { key: string; value: Snapshot };
  records: { key: string; value: StoredRecord };
}

export type Database = IDBPDatabase<CheckinDB>;

export function openDatabase(): Promise<Database> {
  return openDB<CheckinDB>(DATABASE_NAME, DATABASE_VERSION, {
    upgrade(db) {
      db.createObjectStore("meta");
      db.createObjectStore("config");
      db.createObjectStore("snapshots", { keyPath: "eventId" });
      db.createObjectStore("records", { keyPath: "recordId" });
    },
  });
}

const DEVICE_ID = "deviceId";

/**
 * 端末 ID（Design Doc 9.1）。初回の起動時に生成し、ログアウトしても残す。
 * 同じ端末の記録が、ログアウトの前後で同じ端末名で履歴に出るようにするためである
 */
export async function ensureDeviceId(db: Database): Promise<string> {
  const tx = db.transaction("meta", "readwrite");
  const existing = await tx.store.get(DEVICE_ID);
  if (typeof existing === "string") {
    await tx.done;
    return existing;
  }
  const deviceId = crypto.randomUUID();
  await tx.store.put(deviceId, DEVICE_ID);
  await tx.done;
  return deviceId;
}
