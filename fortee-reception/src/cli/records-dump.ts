import { type ServerRecord, serverRecordSchema } from "../core/record.ts";
import { DISTRIBUTION_FORMAT } from "../core/versions.ts";
import { CliError } from "./errors.ts";

// D1 の records の行と、記録のダンプ（records.json。Design Doc 8.5、8.6）。
// export が D1 から読んで書き、restore-records が読んで D1 に戻す。列は Design Doc 7.5 による。

/** records の列。seq を除き、書き戻す順 */
export const RECORD_COLUMNS = [
  "record_id",
  "op_id",
  "op",
  "ticket_token",
  "user_name",
  "ticket_no",
  "reception",
  "reason_kind",
  "reason_text",
  "route",
  "target_record_ids",
  "device_time",
  "device_id",
  "operator_id",
  "operator_name",
  "received_at",
] as const;

/** D1 の records の 1 行 */
export type RecordRow = Record<(typeof RECORD_COLUMNS)[number], string | number | null> & { seq?: number };

/** D1 の行を、記録にする。形が合わなければ止まる。値は出さない */
export function rowToRecord(row: RecordRow): ServerRecord {
  let targetRecordIds: unknown = null;
  if (typeof row.target_record_ids === "string") {
    try {
      targetRecordIds = JSON.parse(row.target_record_ids);
    } catch {
      throw new CliError(`D1 の記録（seq ${row.seq}）の target_record_ids を JSON として読めません`);
    }
  }
  const parsed = serverRecordSchema.safeParse({
    seq: row.seq,
    recordId: row.record_id,
    opId: row.op_id,
    op: row.op,
    ticketToken: row.ticket_token,
    userName: row.user_name,
    ticketNo: row.ticket_no,
    reception: row.reception,
    route: row.route,
    reasonKind: row.reason_kind,
    reasonText: row.reason_text,
    targetRecordIds,
    deviceTime: row.device_time,
    deviceId: row.device_id,
    operatorId: row.operator_id,
    operatorName: row.operator_name,
    receivedAt: row.received_at,
  });
  if (!parsed.success) {
    const where = parsed.error.issues.slice(0, 5).map((issue) => issue.path.join(".")).join("、");
    throw new CliError(`D1 の記録（seq ${row.seq}）が、この版の CLI が読める記録の形ではありません（${where}）`);
  }
  return parsed.data;
}

/** 記録を、D1 の行（seq を除く）にする。target_record_ids は JSON の配列の文字列 */
export function recordToRow(record: ServerRecord): RecordRow {
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
    target_record_ids: record.targetRecordIds === null ? null : JSON.stringify(record.targetRecordIds),
    device_time: record.deviceTime,
    device_id: record.deviceId,
    operator_id: record.operatorId,
    operator_name: record.operatorName,
    received_at: record.receivedAt,
  };
}

/** 記録のダンプ（records.json）。形式の版、環境名、世代、連番の最大を添える（Design Doc 8.5） */
export type RecordsDump = {
  format: number;
  environment: string;
  generation: string;
  maxSeq: number;
  records: ServerRecord[];
};

/**
 * いまの CLI が書くダンプの形式の版。restore-records が読むのも、この版だけである。同じ環境の書き出しを
 * 戻すためのもので、形式は、同じ環境で運用を始めた後は変えない（Design Doc 9.6）
 */
export const RECORDS_DUMP_FORMAT = DISTRIBUTION_FORMAT;

/** 文字列を、記録のダンプとして読む。形が合わなければ止まる。値は出さない */
export function parseRecordsDump(text: string, what: string): RecordsDump {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new CliError(`${what} を JSON として読めません`);
  }
  const wrong = () => new CliError(`${what} が、記録のダンプ（書き出しの records.json）の形ではありません`);
  if (typeof raw !== "object" || raw === null) throw wrong();
  const { format, environment, generation, maxSeq, records } = raw as Record<string, unknown>;
  if (
    typeof format !== "number" ||
    typeof environment !== "string" ||
    typeof generation !== "string" ||
    typeof maxSeq !== "number" ||
    !Array.isArray(records)
  ) {
    throw wrong();
  }
  if (format !== RECORDS_DUMP_FORMAT) {
    throw new CliError(`${what} の形式の版（${format}）を、この版の CLI は読めません`);
  }
  const parsed = records.map((record: unknown, i) => {
    const result = serverRecordSchema.safeParse(record);
    if (!result.success) {
      const where = result.error.issues.slice(0, 5).map((issue) => issue.path.join(".")).join("、");
      throw new CliError(`${what} の records[${i}] が、記録の形ではありません（${where}）`);
    }
    return result.data;
  });
  return { format, environment, generation, maxSeq, records: parsed };
}
