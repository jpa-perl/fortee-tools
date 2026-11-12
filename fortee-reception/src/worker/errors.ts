import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";

// エラー応答の種類（Design Doc 7.6）。応答は { "error": "<種類>" } の JSON
const STATUS = {
  unauthorized: 401,
  forbidden: 403,
  bad_request: 400,
  not_found: 404,
  payload_too_large: 413,
  internal: 500,
} as const;

export type ErrorKind = keyof typeof STATUS;

export function errorResponse(c: Context, kind: ErrorKind): Response {
  return c.json({ error: kind }, STATUS[kind]);
}

function kindOfStatus(status: number): ErrorKind {
  for (const [kind, s] of Object.entries(STATUS)) {
    if (s === status) return kind as ErrorKind;
  }
  return status >= 500 ? "internal" : "bad_request";
}

/** Hono のエラーハンドラ。スタックトレースを応答に含めない */
export function handleError(err: Error, c: Context): Response {
  if (err instanceof HTTPException) {
    return errorResponse(c, kindOfStatus(err.status));
  }
  // 記録の中身、Cookie、トークンを出さない（Design Doc 7.6）。出すのは例外の名前だけにする
  console.error(JSON.stringify({ route: c.req.path, status: 500, error: err.name }));
  return errorResponse(c, "internal");
}
