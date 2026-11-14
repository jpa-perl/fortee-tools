import type { PublishedConfig } from "../../core/config.ts";
import type { Snapshot } from "../../core/snapshot.ts";
import type { SyncCursor } from "../../core/sync.ts";
import {
  addRecords,
  clearForLogout,
  type Database,
  type Meta,
  readOverride,
  readRecords,
  type ReceptionOverride,
  replaceDistribution,
  resetGeneration,
  type StoredRecord,
  type SyncResultWrite,
  writeMeta,
  writeSyncResult,
} from "./db.ts";

// 操作（commands）が書き込みに使う記憶域（Design Doc 6.3）。反映の列（Design Doc 6.13）が、処理に渡す。
//
// 通常モードでは、どの関数も IndexedDB（db.ts）を読み書きする。リハーサルモード（FR-50）では、記録だけを
// メモリに置く記憶域に差し替える。操作は、どちらの記憶域を使っているかを知らない。モードによる違いは、
// どちらの記憶域を選ぶか（commands/runtime.ts の selectStore）の 1 か所にだけある。

export type Store = {
  writeMeta<K extends keyof Meta>(key: K, value: Meta[K]): Promise<void>;
  /** 記録のすべて。起動のときと、記憶域を差し替えたときに、メモリの記録に読み込む */
  readRecords(): Promise<StoredRecord[]>;
  /** 受付の手動の上書き。記憶域を差し替えたときに、メモリの状態に読み込む */
  readOverride(): Promise<ReceptionOverride | null>;
  addRecords(records: readonly StoredRecord[]): Promise<void>;
  writeSyncResult(result: SyncResultWrite): Promise<StoredRecord[]>;
  resetGeneration(cursor: SyncCursor): Promise<StoredRecord[]>;
  replaceDistribution(
    config: PublishedConfig,
    snapshots: readonly Snapshot[],
    options: { clearOverride: boolean },
  ): Promise<void>;
  clearForLogout(loginEpoch: number): Promise<void>;
};

const closed = (): never => {
  throw new Error("接続のない記憶域を使おうとした");
};

/**
 * 接続を開いていない間の記憶域。どの関数も例外を投げる。反映の列は、接続のない間は処理を実行しない
 * （commands/runtime.ts の enqueue）ので、呼ばれるのは実装の誤りである
 */
export const closedStore: Store = {
  writeMeta: closed,
  readRecords: closed,
  readOverride: closed,
  addRecords: closed,
  writeSyncResult: closed,
  resetGeneration: closed,
  replaceDistribution: closed,
  clearForLogout: closed,
};

/** IndexedDB の記憶域 */
export function databaseStore(db: Database): Store {
  return {
    writeMeta: (key, value) => writeMeta(db, key, value),
    readRecords: () => readRecords(db),
    readOverride: () => readOverride(db),
    addRecords: (records) => addRecords(db, records),
    writeSyncResult: (result) => writeSyncResult(db, result),
    resetGeneration: (cursor) => resetGeneration(db, cursor),
    replaceDistribution: (config, snapshots, options) => replaceDistribution(db, config, snapshots, options),
    clearForLogout: (loginEpoch) => clearForLogout(db, loginEpoch),
  };
}

/**
 * リハーサルモードの記憶域。記録と、受付の手動の上書きを、メモリに置く。どちらも、この記憶域を捨てると消える。
 * 記録は空から始まる。上書きは、もとの記憶域の値から始まり、リハーサルモードの間の切り替えは、もとの記憶域に
 * 書かない。練習のための切り替えが、通常モードに戻した後の受付を変えないためである。
 * 設定、スナップショット、ほかの meta は、もとの記憶域（IndexedDB）をそのまま使う。
 * リハーサルモードの間は同期しない（Design Doc 6.6）ので、同期の結果を書く関数は呼ばれない。呼ばれたら
 * 実装の誤りで、本番の記録とリハーサルの記録が混ざる前に、例外を投げて止める
 */
export function rehearsalStore(base: Store): Store {
  const records: StoredRecord[] = [];
  /** リハーサルモードの間に書いた上書き。まだ書いていなければ undefined */
  let override: ReceptionOverride | null | undefined;
  const noSync = (): never => {
    throw new Error("リハーサルモードの記憶域に、同期の結果を書こうとした");
  };
  return {
    ...base,
    writeMeta: async (key, value) => {
      if (key === "override") override = value as ReceptionOverride | null;
      else await base.writeMeta(key, value);
    },
    readOverride: async () => (override === undefined ? base.readOverride() : override),
    readRecords: async () => [...records],
    addRecords: async (added) => {
      records.push(...added);
    },
    writeSyncResult: noSync,
    resetGeneration: noSync,
  };
}
