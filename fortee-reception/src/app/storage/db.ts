import { type DBSchema, type IDBPDatabase, openDB } from "idb";
import { type PublishedConfig, publishedConfigSchema } from "../../core/config.ts";
import { type CheckinRecord, checkinRecordSchema, type ServerRecord } from "../../core/record.ts";
import type { RecordOperator } from "../../core/records.ts";
import { type Snapshot, snapshotSchema } from "../../core/snapshot.ts";
import type { SyncCursor } from "../../core/sync.ts";

// 端末内の記憶域（Design Doc 6.3）。idb の呼び出しは、このモジュールに閉じる。
// ストアに索引は置かない。記録もスナップショットも、起動時に全件をメモリに読む。
//
// 一体に行う書き込み（Design Doc 6.3 の表）は、それぞれ 1 つの関数にして、1 つのトランザクションで書く。
// 読み出した値は、ここで形を確かめてから返す（Design Doc 4.1）。合わなければ例外を投げ、呼び出し側が S99 に移す。

/**
 * データベースの名前。IndexedDB はオリジンごとに分かれ、カンファレンスごとに別の Worker（別のオリジン）として
 * デプロイする（Design Doc 3.6）ので、名前にカンファレンスや開発の段階を含めない
 */
export const DATABASE_NAME = "checkin";

/**
 * いまの名前にする前に使っていた名前。この名前のデータベースが残る端末（名前を変える前の版を開いた、
 * 開発の端末）では、開くときに、読まずに消す。残すと、そのスナップショットと記録は、ログアウト（FR-37）
 * でも消えない
 */
export const LEGACY_DATABASE_NAMES: readonly string[] = ["checkin-dev"];

/** 前の名前のデータベースを消す。結果は待たない。消せなくても、いまのデータベースの動きには関わらない */
function deleteLegacyDatabases(): void {
  for (const name of LEGACY_DATABASE_NAMES) {
    try {
      indexedDB.deleteDatabase(name);
    } catch {
      // 消せなければ、次に開くときにもう一度試す
    }
  }
}

/** 端末の記憶域の版（Design Doc 9.5） */
export const DATABASE_VERSION = 1;

/** IndexedDB を開く待ち（Design Doc 6.13 の調整値）。移行が始まれば数えない */
export const OPEN_TIMEOUT_MS = 10_000;

/** 端末に置く記録。記録に、送信済みの印と、サーバから受け取った連番と受信時刻を加えたもの */
export type StoredRecord = CheckinRecord & {
  /** サーバが 200 を返した要求に含めたか。偽の記録が、未送信の記録である */
  sent: boolean;
  /** サーバから受け取るまでは null */
  seq: number | null;
  receivedAt: number | null;
};

/** 受付の手動の上書き（Design Doc 6.2）。until は上書きした時刻の次の境界。この先に境界がなければ null */
export type ReceptionOverride = { receptionId: string; until: number | null };

/** meta ストアの永続の状態（Design Doc 6.2） */
export type Meta = {
  /** 端末 ID。初回の起動時に生成し、ログアウトしても残す */
  deviceId: string;
  operator: RecordOperator | null;
  sound: boolean;
  vibration: boolean;
  /** 受信位置。初回は null */
  cursor: SyncCursor | null;
  override: ReceptionOverride | null;
  lastSyncAt: number | null;
  /** ログインの番号。ログアウトのたびに 1 増える（Design Doc 6.4） */
  loginEpoch: number;
};

type MetaKey = keyof Meta;

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

export type OpenOptions = {
  /** テストで版上げを起こすためのもの。ふつうは省く */
  version?: number;
  timeoutMs?: number;
  /** ほかの画面が、より新しい版で開こうとしている（versionchange）。その場では閉じない（Design Doc 6.3） */
  onBlocking?: () => void;
  /** 接続がブラウザに切られた */
  onTerminated?: () => void;
};

export type OpenResult =
  | { kind: "ok"; db: Database }
  /** ほかの画面の接続に待たされた（blocked か、移行が始まらないまま時間切れ）。開く要求は取り消せない */
  | { kind: "blocked" };

/**
 * データベースを開く。版を上げる要求がほかの画面の接続に待たされたら、待たずに blocked を返す。
 * 開く要求は取り消せないので、呼び出し側はページを読み込み直して要求を捨てる（Design Doc 6.3）。
 * 読み込み直すまでの間に要求が通ってしまったら、その接続はすぐに閉じる
 */
export function openDatabase(options: OpenOptions = {}): Promise<OpenResult> {
  return new Promise<OpenResult>((resolve, reject) => {
    let settled = false;
    const giveUp = () => {
      if (settled) return;
      settled = true;
      resolve({ kind: "blocked" });
    };
    const timer = setTimeout(giveUp, options.timeoutMs ?? OPEN_TIMEOUT_MS);

    deleteLegacyDatabases();

    openDB<CheckinDB>(DATABASE_NAME, options.version ?? DATABASE_VERSION, {
      upgrade(db, oldVersion) {
        // 移行が始まった後は、ほかの画面に待たされてはいないので、時間を数えない
        clearTimeout(timer);
        if (oldVersion < 1) {
          db.createObjectStore("meta");
          db.createObjectStore("config");
          db.createObjectStore("snapshots", { keyPath: "eventId" });
          db.createObjectStore("records", { keyPath: "recordId" });
        }
        // 前の版からの移行は書いていない。保存する形は、同じ環境で運用を始めた後は変えない
        //（Design Doc 9.6）。カンファレンスのあいだに形を変えるのは自由で、次のカンファレンスは別の
        // オリジンになるので、前のカンファレンスのデータベースを引き継がない
      },
      blocked: () => {
        clearTimeout(timer);
        giveUp();
      },
      blocking: () => options.onBlocking?.(),
      terminated: () => options.onTerminated?.(),
    }).then(
      (db) => {
        clearTimeout(timer);
        if (settled) {
          db.close();
          return;
        }
        settled = true;
        resolve({ kind: "ok", db });
      },
      (error: unknown) => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

// 値の形の確かめ。core にスキーマのない項目（meta と、記録に加えた項目）は、ここで見る

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const isInt = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value);

function isOperator(value: unknown): value is RecordOperator {
  return isObject(value) && typeof value.operatorId === "string" && typeof value.operatorName === "string";
}
function isCursor(value: unknown): value is SyncCursor {
  return isObject(value) && typeof value.generation === "string" && isInt(value.seq) && value.seq >= 0;
}
function isOverride(value: unknown): value is ReceptionOverride {
  return isObject(value) && typeof value.receptionId === "string" && (value.until === null || isInt(value.until));
}

class StorageFormatError extends Error {
  constructor(what: string) {
    super(`端末の記憶域の値の形が合わない: ${what}`);
  }
}

function optional<T>(value: unknown, guard: (value: unknown) => value is T, fallback: T, what: string): T {
  if (value === undefined) return fallback;
  if (!guard(value)) throw new StorageFormatError(what);
  return value;
}

const isBoolean = (value: unknown): value is boolean => typeof value === "boolean";
const isString = (value: unknown): value is string => typeof value === "string";
const nullable =
  <T>(guard: (value: unknown) => value is T) =>
  (value: unknown): value is T | null =>
    value === null || guard(value);

/**
 * meta を読む。端末 ID がなければ生成して保存する（Design Doc 9.1）。
 * ログインしていない画面が書くのは、この端末 ID だけである（Design Doc 6.4）
 */
export async function readMeta(db: Database, newDeviceId: () => string): Promise<Meta> {
  const tx = db.transaction("meta", "readwrite");
  const keys = await tx.store.getAllKeys();
  const values = await tx.store.getAll();
  const raw = new Map(keys.map((key, i) => [key, values[i]]));
  let deviceId = raw.get("deviceId");
  if (deviceId === undefined) {
    deviceId = newDeviceId();
    await tx.store.put(deviceId, "deviceId");
  }
  await tx.done;
  if (!isString(deviceId)) throw new StorageFormatError("deviceId");
  return {
    deviceId,
    operator: optional(raw.get("operator"), nullable(isOperator), null, "operator"),
    sound: optional(raw.get("sound"), isBoolean, true, "sound"),
    vibration: optional(raw.get("vibration"), isBoolean, true, "vibration"),
    cursor: optional(raw.get("cursor"), nullable(isCursor), null, "cursor"),
    override: optional(raw.get("override"), nullable(isOverride), null, "override"),
    lastSyncAt: optional(raw.get("lastSyncAt"), nullable(isInt), null, "lastSyncAt"),
    loginEpoch: optional(raw.get("loginEpoch"), isInt, 0, "loginEpoch"),
  };
}

/** meta の 1 項目を書く */
export async function writeMeta<K extends MetaKey>(db: Database, key: K, value: Meta[K]): Promise<void> {
  await db.put("meta", value, key);
}

function isStoredRecord(value: unknown): value is StoredRecord {
  if (!isObject(value)) return false;
  if (typeof value.sent !== "boolean") return false;
  if (value.seq !== null && !isInt(value.seq)) return false;
  if (value.receivedAt !== null && !isInt(value.receivedAt)) return false;
  // 形だけを確かめ、値は読んだものをそのまま使う。検証の結果は、加えた項目（sent など）を落とす
  return checkinRecordSchema.safeParse(value).success;
}

export type StoredData = {
  config: PublishedConfig | null;
  snapshots: Snapshot[];
  records: StoredRecord[];
};

/** 設定、スナップショット、記録を読む。ロックを取ってから呼ぶ（Design Doc 6.3） */
export async function readData(db: Database): Promise<StoredData> {
  const tx = db.transaction(["config", "snapshots", "records"], "readonly");
  const config = (await tx.objectStore("config").get("current")) ?? null;
  const snapshots = await tx.objectStore("snapshots").getAll();
  const records = await tx.objectStore("records").getAll();
  await tx.done;
  if (config !== null && !publishedConfigSchema.safeParse(config).success) throw new StorageFormatError("config");
  for (const snapshot of snapshots) {
    if (!snapshotSchema.safeParse(snapshot).success) throw new StorageFormatError("snapshots");
  }
  for (const record of records) {
    if (!isStoredRecord(record)) throw new StorageFormatError("records");
  }
  return { config, snapshots, records };
}

/**
 * トランザクションの確定を待つ。個々の要求の失敗も受けて、未処理の拒否を残さない。
 * 1 つでも失敗すれば、トランザクションは破棄され、何も書かれない
 */
async function finish(tx: { done: Promise<void> }, requests: Promise<unknown>[]): Promise<void> {
  await Promise.all([...requests, tx.done]);
}

/** 1 回の操作で作った記録のすべてを、一体に書く（Design Doc 6.3） */
export async function addRecords(db: Database, records: readonly StoredRecord[]): Promise<void> {
  const tx = db.transaction("records", "readwrite");
  await finish(tx, records.map((record) => tx.store.add(record)));
}

export type SyncResultWrite = {
  /** 要求に載せた記録の ID。これらにだけ sent を付ける */
  sentRecordIds: readonly string[];
  /** 受け取った記録 */
  received: readonly ServerRecord[];
  cursor: SyncCursor;
};

/**
 * 同期の 1 要求の結果を、一体に書く（Design Doc 6.3、6.13）。送った記録への sent の印、受け取った記録の合流、
 * 受信位置の更新。端末にすでにある記録は、seq と receivedAt をサーバの値で書き換える。
 * 書いた後の記録（変わったものだけ）を返す
 */
export async function writeSyncResult(db: Database, result: SyncResultWrite): Promise<StoredRecord[]> {
  const tx = db.transaction(["records", "meta"], "readwrite");
  const store = tx.objectStore("records");
  const changed = new Map<string, StoredRecord>();
  for (const recordId of result.sentRecordIds) {
    const existing = await store.get(recordId);
    if (existing === undefined) continue;
    changed.set(recordId, { ...existing, sent: true });
  }
  for (const record of result.received) {
    const existing = changed.get(record.recordId) ?? (await store.get(record.recordId));
    changed.set(
      record.recordId,
      existing === undefined
        ? { ...record, sent: true }
        : { ...existing, seq: record.seq, receivedAt: record.receivedAt },
    );
  }
  await finish(tx, [
    ...[...changed.values()].map((record) => store.put(record)),
    tx.objectStore("meta").put(result.cursor, "cursor"),
  ]);
  return [...changed.values()];
}

/**
 * 世代の変化の初期化（Design Doc 4.5、6.13）。すべての記録の sent を偽、seq を null にし、
 * 受信位置を初期化する。receivedAt は残す。書いた後の全記録を返す
 */
export async function resetGeneration(db: Database, cursor: SyncCursor): Promise<StoredRecord[]> {
  const tx = db.transaction(["records", "meta"], "readwrite");
  const store = tx.objectStore("records");
  const records = (await store.getAll()).map((record): StoredRecord => ({ ...record, sent: false, seq: null }));
  await finish(tx, [...records.map((record) => store.put(record)), tx.objectStore("meta").put(cursor, "cursor")]);
  return records;
}

/**
 * 配布物の差し替え（Design Doc 6.7）。config と snapshots の全部を、一体に書く。
 * 差し替えた設定に手動の上書きが指す受付がないときは、上書きも同じトランザクションで消す
 */
export async function replaceDistribution(
  db: Database,
  config: PublishedConfig,
  snapshots: readonly Snapshot[],
  options: { clearOverride: boolean },
): Promise<void> {
  const tx = db.transaction(["config", "snapshots", "meta"], "readwrite");
  const store = tx.objectStore("snapshots");
  await finish(tx, [
    tx.objectStore("config").put(config, "current"),
    store.clear(),
    ...snapshots.map((snapshot) => store.put(snapshot)),
    ...(options.clearOverride ? [tx.objectStore("meta").delete("override")] : []),
  ]);
}

/**
 * ログアウトの消去（Design Doc 6.3、FR-37）。meta の端末 ID、音と振動の設定、ログインの番号を除いて、
 * すべてのストアを消す。ログインの番号は、上げた値を書く
 */
export async function clearForLogout(db: Database, loginEpoch: number): Promise<void> {
  const tx = db.transaction(["meta", "config", "snapshots", "records"], "readwrite");
  const meta = tx.objectStore("meta");
  const kept: string[] = ["deviceId", "sound", "vibration"] satisfies MetaKey[];
  const stale = (await meta.getAllKeys()).filter((key) => !kept.includes(key));
  await finish(tx, [
    ...stale.map((key) => meta.delete(key)),
    meta.put(loginEpoch, "loginEpoch"),
    tx.objectStore("config").clear(),
    tx.objectStore("snapshots").clear(),
    tx.objectStore("records").clear(),
  ]);
}
