import type { CheckinRecord, ServerRecord } from "../core/record.ts";
import {
  SYNC_LIMIT_MAX,
  SYNC_RECEIVE_MAX_BYTES,
  type SyncRequest,
  type SyncResponse,
  type Versions,
} from "../core/sync.ts";
import { INSERT_RECORDS, type Row, runBatch, SELECT_META, SELECT_RECORDS_AFTER, UPSERT_DEVICE } from "./db.ts";

// 同期の処理（Design Doc 4.5、7.3）。検証済みの要求を受け取り、4 文を 1 回の batch() で実行して応答を作る。
// Worker は記録の中身を解釈しない。鍵の名前を列名に合わせて渡し、返ってきた行を記録の形に戻すだけである。

/** 端末の時計の差とアプリのリリースを書き換える間隔（Design Doc 7.3、9.2） */
export const DEVICE_MEASURE_INTERVAL_MS = 10 * 60 * 1000;

export type SyncOptions = {
  /** サーバの現在時刻。記録の受信時刻と、時計の差の測定時刻になる */
  now: number;
  /** 1 回の応答で返す記録のバイト数の上限。試験で小さくするために渡せる。省略すると 128 KiB */
  receiveMaxBytes?: number;
};

/** 記録を、鍵が列名の行にする。値は検証済みのものをそのまま渡す */
function toRow(record: CheckinRecord): Row {
  return {
    record_id: record.recordId,
    op_id: record.opId,
    op: record.op,
    ticket_token: record.ticketToken,
    user_name: record.userName,
    ticket_no: record.ticketNo,
    reception: record.reception,
    reason_kind: record.reasonKind,
    reason_text: record.reasonText,
    route: record.route,
    // 配列は、文の中の ->> が JSON の文字列にして入れる。null は NULL として入る
    target_record_ids: record.targetRecordIds,
    device_time: record.deviceTime,
    device_id: record.deviceId,
    operator_id: record.operatorId,
    operator_name: record.operatorName,
  };
}

/** D1 の行を、サーバが返す記録にする。保存したときに検証を通った値なので、ここでは検証しない */
function toServerRecord(row: Row): ServerRecord {
  const targetRecordIds = row["target_record_ids"];
  return {
    seq: row["seq"],
    recordId: row["record_id"],
    opId: row["op_id"],
    op: row["op"],
    ticketToken: row["ticket_token"],
    userName: row["user_name"],
    ticketNo: row["ticket_no"],
    reception: row["reception"],
    route: row["route"],
    reasonKind: row["reason_kind"],
    reasonText: row["reason_text"],
    // JSON の配列の文字列で返るので、配列に戻す
    targetRecordIds: typeof targetRecordIds === "string" ? (JSON.parse(targetRecordIds) as unknown) : null,
    deviceTime: row["device_time"],
    deviceId: row["device_id"],
    operatorId: row["operator_id"],
    operatorName: row["operator_name"],
    receivedAt: row["received_at"],
  } as ServerRecord;
}

export async function runSync(db: D1Database, request: SyncRequest, options: SyncOptions): Promise<SyncResponse> {
  const { now } = options;
  const limit = request.limit ?? SYNC_LIMIT_MAX;
  const cursor = request.cursor;

  const [, , metaRows, recordRows] = await runBatch(db, [
    { sql: INSERT_RECORDS, params: [JSON.stringify(request.records.map(toRow)), now] },
    {
      sql: UPSERT_DEVICE,
      params: [request.deviceId, now - request.deviceTime, now, DEVICE_MEASURE_INTERVAL_MS, request.appVersion],
    },
    { sql: SELECT_META, params: [] },
    {
      sql: SELECT_RECORDS_AFTER,
      // 初回（cursor が null）は、世代を比べずに先頭から読む。件数の上限より 1 件多く読んで、続きの有無を知る
      params: [cursor?.seq ?? 0, limit + 1, cursor?.generation ?? null, options.receiveMaxBytes ?? SYNC_RECEIVE_MAX_BYTES],
    },
  ]);

  const meta = metaRows?.[0];
  const generation = meta?.["generation"];
  // 世代はマイグレーションが入れる。なければ、マイグレーションを適用していない DB である
  if (typeof generation !== "string") throw new Error("meta.generation is missing");
  const versionsText = meta?.["versions"];
  // versions の値は、応答の versions と同じ形の JSON。中身を解釈せずに応答に入れる
  const versions = typeof versionsText === "string" ? (JSON.parse(versionsText) as Versions) : null;

  // 要求の世代が現在の世代と違えば、記録は保存したうえで、返さない（Design Doc 4.5）。
  // 4 の文も同じ比較で何も読まないが、応答の値は 3 の結果と要求を比べて決める
  if (cursor !== null && cursor.generation !== generation) {
    return { generation, nextSeq: 0, hasMore: false, records: [], versions };
  }

  const rows = recordRows ?? [];
  // 返ってきた行のうち limit 件までを応答に入れる。文は limit + 1 件まで返しうる
  const records = rows.slice(0, limit).map(toServerRecord);
  // 内側で読めた行の数が、応答に入れた件数より多ければ、続きがある
  const fetched = rows.length > 0 ? Number(rows[0]?.["fetched"]) : 0;
  // 受信位置は、読んだ最後ではなく、実際に返した最後の記録の連番。0 件なら要求の位置のまま
  const nextSeq = records.at(-1)?.seq ?? cursor?.seq ?? 0;

  return { generation, nextSeq, hasMore: fetched > records.length, records, versions };
}
