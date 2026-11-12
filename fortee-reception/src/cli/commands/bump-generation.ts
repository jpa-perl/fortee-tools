import { randomBytes } from "node:crypto";
import { CliError } from "../errors.ts";
import { textParam } from "../sql.ts";
import type { Target } from "../target.ts";
import { d1Execute } from "../wrangler.ts";

// bump-generation（Design Doc 8.1、8.6 の 5）。meta の世代を書き換える。
// 次の同期で、全端末が送り直しと受け取り直しを始める（Design Doc 4.5、7.3）。
// DB を戻した後の復旧の最後に、publish と restore-records を済ませてから実行する。

export async function bumpGeneration(target: Target, log: (line: string) => void): Promise<void> {
  // マイグレーションの初期値と同じ、32 文字の 16 進の乱数
  const next = randomBytes(16).toString("hex");
  const rows = await d1Execute<{ value: string }>(
    target,
    `INSERT INTO meta (key, value) VALUES ('generation', ${textParam(next)}) ` +
      "ON CONFLICT (key) DO UPDATE SET value = excluded.value RETURNING value",
  );
  if (rows[0]?.value !== next) throw new CliError("世代を書き換えられませんでした");
  log(`世代を書き換えました（環境 ${target.env}）: ${next}`);
}
