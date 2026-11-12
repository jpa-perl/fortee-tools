import { createMiddleware } from "hono/factory";
import type { AppEnv } from "./env.ts";

// Workers Logs に出す、要求 1 件につき 1 行の構造化ログ（Design Doc 7.6）。
// 出すのは、ルート、状態コード、端末 ID、送られた記録の件数、返した記録の件数、処理時間と、
// 失敗の種類を表す短い語だけである。記録の中身、スナップショット、Cookie、Discord の認可コードと
// トークンは出さない。ルートにはパスだけを使い、クエリ（認可コードと state が入る）は出さない。

export type LogFields = {
  /** 同期の端末 ID */
  deviceId?: string;
  /** 送られた記録の件数 */
  sent?: number;
  /** 返した記録の件数 */
  returned?: number;
  /** 400 のとき、スキーマの検証で失敗した項目のパス */
  invalid?: string[];
  /** ログインの結果（ok、no-role、failed） */
  login?: string;
  /** 失敗の理由を表す短い語。例外の名前など */
  reason?: string;
};

export const requestLog = createMiddleware<AppEnv>(async (c, next) => {
  const startedAt = Date.now();
  const fields: LogFields = {};
  c.set("log", fields);
  await next();
  console.log(
    JSON.stringify({
      route: c.req.path,
      method: c.req.method,
      status: c.res.status,
      ...fields,
      ms: Date.now() - startedAt,
    }),
  );
});
