import { readFile } from "node:fs/promises";
import { CliError } from "../errors.ts";
import { parseRecordsDump, RECORD_COLUMNS, recordToRow, type RecordRow } from "../records-dump.ts";
import { jsonParam } from "../sql.ts";
import type { Target } from "../target.ts";
import { d1ExecuteFile } from "../wrangler.ts";

// restore-records（Design Doc 8.1、8.6 の 4）。書き出しの記録のダンプ（records.json）を、D1 に戻す。
// DB を以前の時点に戻した後の復旧で、migrate と publish の後、bump-generation の前に実行する。
//
// ダンプの記録のうち、D1 にない記録 ID のものは、ダンプの受信時刻で新しく入れる（連番は新しく付く）。
// 同じ記録 ID の記録が D1 にすでにあれば、受信時刻だけをダンプの値に書き換える。ほかの列と連番は変えない。
// 何度実行しても結果は同じなので、途中で止まったら、同じダンプでやり直せる。

/** 1 文の大きさの上限（バイト）。D1 の 1 文は 100 KB までなので、余裕を持たせる（Design Doc 8.2） */
const STATEMENT_MAX_BYTES = 90_000;

/** 記録の配列を 1 つの JSON にして、16 進の BLOB リテラルで渡す文（Design Doc 8.6） */
function statementOf(rows: readonly RecordRow[]): string {
  const columns = RECORD_COLUMNS.join(", ");
  const values = RECORD_COLUMNS.map((column) => `value ->> '${column}'`).join(", ");
  return (
    `INSERT INTO records (${columns}) SELECT ${values} FROM json_each(${jsonParam(rows)}) WHERE true ` +
    "ON CONFLICT (record_id) DO UPDATE SET received_at = excluded.received_at " +
    "WHERE records.received_at <> excluded.received_at;"
  );
}

/** 記録を、1 文が上限に収まるように分けて、文を並べる */
export function restoreStatements(rows: readonly RecordRow[], maxBytes: number = STATEMENT_MAX_BYTES): string[] {
  // 文の大きさは、値のない文の大きさに、16 進にした JSON の大きさ（UTF-8 のバイト数の 2 倍）を足したもの
  const base = Buffer.byteLength(statementOf([]));
  const hexBytes = (row: RecordRow) => 2 * (Buffer.byteLength(JSON.stringify(row)) + 1);
  const statements: string[] = [];
  let batch: RecordRow[] = [];
  let size = base;
  for (const row of rows) {
    if (batch.length > 0 && size + hexBytes(row) > maxBytes) {
      statements.push(statementOf(batch));
      batch = [];
      size = base;
    }
    batch.push(row);
    size += hexBytes(row);
  }
  if (batch.length > 0) statements.push(statementOf(batch));
  return statements;
}

export type RestoreRecordsOptions = {
  /** 書き出しの records.json のパス */
  from: string;
};

export async function restoreRecords(target: Target, options: RestoreRecordsOptions, log: (line: string) => void): Promise<void> {
  let text: string;
  try {
    text = await readFile(options.from, "utf8");
  } catch {
    throw new CliError(`--from の ${options.from} を読めません`);
  }
  const dump = parseRecordsDump(text, options.from);

  // ダンプに添えた環境名が --env と一致しなければ止まる。別のカンファレンスの記録を入れない
  if (dump.environment !== target.env) {
    throw new CliError(`${options.from} は環境 "${dump.environment}" の書き出しで、--env（"${target.env}"）と一致しません`);
  }

  // 連番の順に入れる。新しく入る記録に、ダンプと同じ順で連番が付く
  const rows = [...dump.records].sort((a, b) => a.seq - b.seq).map(recordToRow);
  const statements = restoreStatements(rows);
  if (statements.length > 0) await d1ExecuteFile(target, `${statements.join("\n")}\n`);

  log(`記録のダンプを D1 に戻しました（環境 ${target.env}）: ${rows.length} 件、${statements.length} 文`);
  log(`  ダンプの世代 ${dump.generation}、連番の最大 ${dump.maxSeq}`);
  log("続けて bump-generation を実行してください。全端末が、次の同期で送り直しと受け取り直しを始めます");
}
