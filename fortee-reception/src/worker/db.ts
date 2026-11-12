// D1 の呼び出し（Design Doc 7.5、3.3）。D1 に触れるのはこのモジュールだけにし、
// SQL 文と「文とパラメータを受け取って行を返す」関数だけを置く。
// Turso に替えるときは、runBatch を差し替える。文は同じ SQLite の SQL なので変えない。
//
// 文は、Workers Free の CPU 時間と D1 の行数の条件（バックエンド 5 章）のために手で書いてある。
// 読み出しは主キーか索引の範囲で行い、表全体を走査しない。

export type SqlValue = string | number | null;
export type Statement = { sql: string; params: readonly SqlValue[] };
export type Row = Record<string, unknown>;

/**
 * 文を 1 回の batch() で実行し、文ごとの行を返す。batch() は 1 つのトランザクションとして実行され、
 * Worker の呼び出しごとのクエリの数には 1 件と数えられる
 */
export async function runBatch(db: D1Database, statements: readonly Statement[]): Promise<Row[][]> {
  const results = await db.batch<Row>(statements.map(({ sql, params }) => db.prepare(sql).bind(...params)));
  return results.map((result) => result.results);
}

// 同期の 4 文（Design Doc 7.3）

/**
 * 1. 記録の保存。?1 は、鍵を列名に合わせた記録の配列の JSON 文字列。?2 は受信時刻。
 * INSERT ... SELECT に ON CONFLICT を付けるときは、構文のあいまいさを避けるため WHERE が要る
 */
export const INSERT_RECORDS = `
INSERT INTO records (record_id, op_id, op, ticket_token, user_name, ticket_no, reception, reason_kind, reason_text, route,
                     target_record_ids, device_time, device_id, operator_id, operator_name, received_at)
SELECT value ->> 'record_id', value ->> 'op_id', value ->> 'op', value ->> 'ticket_token',
       value ->> 'user_name', value ->> 'ticket_no',
       value ->> 'reception', value ->> 'reason_kind', value ->> 'reason_text', value ->> 'route',
       value ->> 'target_record_ids',
       value ->> 'device_time', value ->> 'device_id', value ->> 'operator_id', value ->> 'operator_name', ?2
FROM json_each(?1) WHERE true
ON CONFLICT (record_id) DO NOTHING`;

/**
 * 2. 時計の差とアプリのリリース。?1 端末 ID、?2 差（receivedAt - deviceTime）、?3 測定時刻、?4 書き換えの間隔、
 * ?5 アプリのリリース。前回の測定から ?4 ミリ秒経っていなければ、行を読み書きしない。
 * 最大の差（絶対値）とその測定時刻は、同じ行の書き込みの中で、絶対値が大きくなったときだけ更新する
 */
export const UPSERT_DEVICE = `
INSERT INTO devices (device_id, clock_offset_ms, measured_at, max_abs_offset_ms, max_measured_at, app_version)
VALUES (?1, ?2, ?3, abs(?2), ?3, ?5)
ON CONFLICT (device_id) DO UPDATE SET
  clock_offset_ms = excluded.clock_offset_ms,
  measured_at = excluded.measured_at,
  app_version = excluded.app_version,
  max_measured_at = CASE WHEN excluded.max_abs_offset_ms > devices.max_abs_offset_ms THEN excluded.measured_at ELSE devices.max_measured_at END,
  max_abs_offset_ms = max(devices.max_abs_offset_ms, excluded.max_abs_offset_ms)
WHERE excluded.measured_at - devices.measured_at >= ?4`;

/** 3. 世代と版。versions は、まだ公開していなければ NULL */
export const SELECT_META = `
SELECT (SELECT value FROM meta WHERE key = 'generation') AS generation,
       (SELECT value FROM meta WHERE key = 'versions') AS versions`;

/**
 * 4. 受信位置（?1）より後ろの記録。?2 は件数の上限より 1 件多い数、?3 は要求の世代（初回は NULL）、
 * ?4 は累積のバイト数の上限。要求の世代が現在の世代と違えば読まない。
 * 表を読むのはいちばん内側だけで、連番の範囲の ?2 行にとどまる。
 * bytes は記録 1 件の JSON の UTF-8 のバイト数で、その累積が上限を超えない行だけを返す。
 * 先頭の 1 件は、それだけで上限を超えても返す（total_bytes = bytes が成り立つのは先頭の行だけである）。
 * fetched は内側で読めた行の数で、続きの有無の判断に使う。
 *
 * 値だけを json_array で数え、列名の分を定数で足す。17 列を json_object に並べると 34 引数になり、
 * D1 の関数の引数の上限（32）を超える。208 = 列名の長さの合計 157 + 列ごとの引用符とコロンの 3 × 17。
 * 記録の列を変えるときは、この定数も変える
 */
export const SELECT_RECORDS_AFTER = `
SELECT seq, record_id, op_id, op, ticket_token, user_name, ticket_no, reception, reason_kind, reason_text, route,
       target_record_ids, device_time, device_id, operator_id, operator_name, received_at, fetched
FROM (
  SELECT *,
         sum(bytes) OVER (ORDER BY seq ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS total_bytes,
         count(*) OVER () AS fetched
  FROM (
    SELECT seq, record_id, op_id, op, ticket_token, user_name, ticket_no, reception, reason_kind, reason_text, route,
           target_record_ids, device_time, device_id, operator_id, operator_name, received_at,
           length(CAST(json_array(seq, record_id, op_id, op, ticket_token, user_name, ticket_no, reception, reason_kind,
                                  reason_text, route, json(target_record_ids), device_time, device_id, operator_id,
                                  operator_name, received_at) AS BLOB)) + 208 AS bytes
    FROM records
    WHERE seq > ?1
      AND (?3 IS NULL OR (SELECT value FROM meta WHERE key = 'generation') = ?3)
    ORDER BY seq LIMIT ?2
  )
)
WHERE total_bytes <= ?4 OR total_bytes = bytes
ORDER BY seq`;
