import { type Context, Hono } from "hono";
import { EVENT_ID_PATTERN } from "../../core/fields.ts";
import type { MeResponse } from "../../core/sync.ts";
import { errorResponse } from "../errors.ts";
import { requireJsonBody, requireSameOrigin } from "../origin.ts";
import { requireSession, type SessionEnv } from "../session.ts";

// /api/ 以下のルート（Design Doc 7.1）。すべて、同じオリジンからの要求であることと、セッションを要する。
// 本文を受ける要求には、Content-Type: application/json を求める（Design Doc 9.3）。
//
// まだないルート:
//   POST /api/sync    同期（Design Doc 4.5、7.3）

/** 版。エポックミリ秒の整数（Design Doc 9.5） */
const VERSION = /^[0-9]{1,16}$/;

export function createApiRoutes(): Hono<SessionEnv> {
  const api = new Hono<SessionEnv>();

  api.use("*", requireSameOrigin, requireSession, requireJsonBody);

  api.get("/me", (c) => {
    const session = c.get("session");
    return c.json({ operatorId: session.sub, operatorName: session.name } satisfies MeResponse);
  });

  // 配布物の配信（Design Doc 7.4）。KV からストリームのまま返し、Worker では解析しない
  api.get("/config/:version", (c) => {
    const version = c.req.param("version");
    if (!VERSION.test(version)) return errorResponse(c, "not_found");
    return distribute(c, `config:${version}`);
  });

  api.get("/snapshot/:eventId/:version", (c) => {
    const { eventId, version } = c.req.param();
    // イベント ID の形は、設定とスナップショットのスキーマと同じ（core）
    if (!EVENT_ID_PATTERN.test(eventId) || !VERSION.test(version)) return errorResponse(c, "not_found");
    return distribute(c, `snapshot:${eventId}:${version}`);
  });

  return api;
}

async function distribute(c: Context<SessionEnv>, key: string): Promise<Response> {
  const body = await c.env.KV.get(key, "stream");
  // 要求された版が KV になければ 404。端末は次の同期で最新の版を知る
  if (body === null) return errorResponse(c, "not_found");
  return new Response(body, {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      // チケットトークンを含むので、共有キャッシュに置かない（PRD 7.1）
      "Cache-Control": "private, no-store",
    },
  });
}
