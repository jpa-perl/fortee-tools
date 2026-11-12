-- 初期のマイグレーション。Design Doc 7.5 の表と索引。
-- wrangler は、マイグレーションが適用済みかをファイル名だけで判定する。適用した環境があるあいだは、
-- このファイルを書き換えず、名前も変えない。スキーマを変えるときは、マイグレーションを足す。

-- seq は rowid の別名で、書き込みのトランザクションの中で付く連番。受信位置に使う。
-- AUTOINCREMENT は付けない。付けると sqlite_sequence への書き込みが記録ごとに増える
CREATE TABLE records (
  seq INTEGER PRIMARY KEY,
  record_id TEXT NOT NULL,
  op_id TEXT NOT NULL,
  op TEXT NOT NULL,
  ticket_token TEXT NOT NULL,
  user_name TEXT NOT NULL,
  ticket_no TEXT NOT NULL,
  reception TEXT,
  reason_kind TEXT,
  reason_text TEXT,
  route TEXT,
  target_record_ids TEXT,                -- 取り消しが打ち消すチェックインの記録 ID。JSON の配列の文字列。チェックインでは NULL
  device_time INTEGER NOT NULL,
  device_id TEXT NOT NULL,
  operator_id TEXT NOT NULL,
  operator_name TEXT NOT NULL,
  received_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX records_record_id ON records (record_id);
CREATE INDEX records_ticket_token ON records (ticket_token);

-- 小さな表は WITHOUT ROWID にし、主キーの索引への書き込みが別に数えられないようにする
CREATE TABLE devices (
  device_id TEXT PRIMARY KEY,
  clock_offset_ms INTEGER NOT NULL,      -- 最新の差（receivedAt - deviceTime）
  measured_at INTEGER NOT NULL,          -- その測定時刻。最後に同期した時刻の目安にも使う
  max_abs_offset_ms INTEGER NOT NULL,    -- 差の絶対値の最大
  max_measured_at INTEGER NOT NULL,      -- 最大を記録した測定時刻
  app_version TEXT NOT NULL              -- 最後に測定したときの受付アプリのリリース
) WITHOUT ROWID;

-- meta には世代（generation）、版（versions）、環境名（environment）を置く。
-- environment は CLI だけが書き、Worker は読まない
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;

-- 世代の初期値。DB の記録の連なりの同一性を表す乱数の文字列で、
-- DB を戻した後の復旧で CLI が書き換える（Design Doc 7.3、8.6、9.5）
INSERT INTO meta (key, value) VALUES ('generation', lower(hex(randomblob(16))));
