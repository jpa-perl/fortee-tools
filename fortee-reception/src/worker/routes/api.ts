import { type Context, Hono } from "hono";
import { EVENT_ID_PATTERN } from "../../core/fields.ts";
import { type MeResponse, SYNC_BODY_MAX_BYTES, type SyncResponse, syncRequestSchema } from "../../core/sync.ts";
import { errorResponse } from "../errors.ts";
import { requireJsonBody, requireSameOrigin } from "../origin.ts";
import { renewSessionIfNeeded, requireSession, type SessionEnv } from "../session.ts";
import { runSync } from "../sync.ts";

// /api/ 以下のルート（Design Doc 7.1）。すべて、同じオリジンからの要求であることと、セッションを要する。
// 本文を受ける要求には、Content-Type: application/json を求める（Design Doc 9.3）。

/** 版。エポックミリ秒の整数（Design Doc 9.5） */
const VERSION = /^[0-9]{1,16}$/;

export function createApiRoutes(): Hono<SessionEnv> {
  const api = new Hono<SessionEnv>();

  api.use("*", requireSameOrigin, requireSession, requireJsonBody);

  api.get("/me", (c) => {
    const session = c.get("session");
    return c.json({ operatorId: session.sub, operatorName: session.name } satisfies MeResponse);
  });

  // 同期（Design Doc 4.5、7.3）
  api.post("/sync", async (c) => {
    const log = c.get("log");

    const text = await readBodyText(c.req.raw, SYNC_BODY_MAX_BYTES);
    if (text === null) return errorResponse(c, "payload_too_large");

    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      log.invalid = ["(json)"];
      return errorResponse(c, "bad_request");
    }

    // 端末と同じ core のスキーマで検証する。知らない項目は落ち、知らない v は通らない。
    // 通らなければ、記録を 1 件も保存しない（Design Doc 4.1）
    const parsed = syncRequestSchema.safeParse(body);
    if (!parsed.success) {
      // 出すのは失敗した項目のパスだけ。値と文言は出さない（Design Doc 7.6）
      log.invalid = [...new Set(parsed.error.issues.map((issue) => issue.path.join(".")))].slice(0, 20);
      return errorResponse(c, "bad_request");
    }
    const request = parsed.data;
    log.deviceId = request.deviceId;
    log.sent = request.records.length;

    const now = Date.now();
    const response: SyncResponse = await runSync(c.env.DB, request, { now });
    log.returned = response.records.length;

    // 発行し直したセッションの Cookie を付けるのは、200 の応答だけ（Design Doc 4.5、7.2）
    await renewSessionIfNeeded(c, now);
    return c.json(response);
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

/**
 * 本文を、上限のバイト数まで読んで文字列にする。上限を超えれば null（413）。
 * Content-Length が上限を超えていれば読まずに断り、なければ（または偽っていれば）読みながら数えて、
 * 超えたところで読むのをやめる
 */
async function readBodyText(request: Request, maxBytes: number): Promise<string | null> {
  const declared = Number(request.headers.get("Content-Length") ?? "0");
  if (declared > maxBytes) return null;
  if (request.body === null) return "";

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
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
