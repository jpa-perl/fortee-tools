import { Hono } from "hono";
import { requireSameOrigin } from "../origin.ts";
import { clearSessionCookie, requireSession, type SessionEnv } from "../session.ts";

// /auth/ 以下のルート（Design Doc 7.1）。
//
// まだないルート:
//   GET /auth/discord/start      認可の開始（Design Doc 7.2）
//   GET /auth/discord/callback   コールバックとセッションの発行（Design Doc 7.2）
//
// ログインの途中で置く state と code_verifier の Cookie にも、セッションの Cookie と同じく
// __Host- 接頭辞を付ける（__Host-state、__Host-code_verifier）。接頭辞には Path=/ が要る（Design Doc 7.2）

export function createAuthRoutes(): Hono<SessionEnv> {
  const auth = new Hono<SessionEnv>();

  // セッションの Cookie を消す。端末のデータの消去は受付アプリが行う（FR-37）
  // 本文は受けないので、Content-Type は求めない
  auth.post("/logout", requireSameOrigin, requireSession, (c) => {
    clearSessionCookie(c);
    return c.body(null, 204);
  });

  return auth;
}
