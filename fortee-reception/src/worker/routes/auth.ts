import { type Context, Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { authorizeUrl, exchangeCode, fetchOperator } from "../discord.ts";
import { requireSameOrigin } from "../origin.ts";
import {
  clearSessionCookie,
  issueSession,
  requireSession,
  type SessionEnv,
  setSessionCookie,
  toBase64Url,
} from "../session.ts";

// /auth/ 以下のルート（Design Doc 7.1、7.2）。
//
// 認可の開始とコールバックは独立したルートにしてある。ワンタイムコードの予備案（端末の挙動 3.4）が
// 要るときは、開始記録の表を足し、この 2 つを書き換えて、コードの表示と入力のルートを足す（Design Doc 3.3）。

/**
 * ログインの途中で置く Cookie。セッションの Cookie と同じく __Host- 接頭辞を付け、
 * 同じサイトのほかのホストに置かせない。接頭辞には Path=/ が要るので、パスを /auth/ には限らない
 */
export const STATE_COOKIE = "__Host-state";
export const CODE_VERIFIER_COOKIE = "__Host-code_verifier";
/** 認可を始めてからコールバックまでの猶予（秒） */
const LOGIN_COOKIE_MAX_AGE = 600;

const loginCookieAttributes = { httpOnly: true, secure: true, sameSite: "Lax", path: "/" } as const;

/** 32 バイトの乱数を base64url にした 43 文字。code_verifier の長さの条件（43〜128 文字。RFC 7636 の 4.1）を満たす */
function randomToken(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

async function codeChallengeOf(codeVerifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(codeVerifier));
  return toBase64Url(new Uint8Array(digest));
}

/** Discord のアプリケーションに登録するリダイレクト URI。この Worker のオリジンから決まる（Design Doc 3.6） */
function redirectUriOf(c: Context): string {
  return `${new URL(c.req.url).origin}/auth/discord/callback`;
}

type LoginResult = "ok" | "no-role" | "failed";

/** 受付アプリに戻す。結果はクエリで伝え、受付アプリが新しい起動として読む（Design Doc 6.4） */
function backToApp(c: Context<SessionEnv>, result: LoginResult, reason?: string): Response {
  const log = c.get("log");
  log.login = result;
  if (reason !== undefined) log.reason = reason;
  c.header("Cache-Control", "no-store");
  return c.redirect(`/?login=${result}`, 302);
}

export function createAuthRoutes(): Hono<SessionEnv> {
  const auth = new Hono<SessionEnv>();

  // 認可の開始。state と code_verifier を Cookie に置き、Discord の認可画面に移す
  auth.get("/discord/start", async (c) => {
    // 秘密が設定されていない Worker では、認可を始めない（500 になる）
    if (typeof c.env.DISCORD_CLIENT_ID !== "string" || c.env.DISCORD_CLIENT_ID === "") {
      throw new Error("DISCORD_CLIENT_ID is not set");
    }
    const state = randomToken();
    const codeVerifier = randomToken();
    const attributes = { ...loginCookieAttributes, maxAge: LOGIN_COOKIE_MAX_AGE };
    setCookie(c, STATE_COOKIE, state, attributes);
    setCookie(c, CODE_VERIFIER_COOKIE, codeVerifier, attributes);
    c.header("Cache-Control", "no-store");
    return c.redirect(
      authorizeUrl({
        clientId: c.env.DISCORD_CLIENT_ID,
        redirectUri: redirectUriOf(c),
        state,
        codeChallenge: await codeChallengeOf(codeVerifier),
      }),
      302,
    );
  });

  // コールバック。Discord からの画面の遷移で届くので、同じオリジンの照合は掛けない。
  // 代わりに、state を Cookie と照合する
  auth.get("/discord/callback", async (c) => {
    const expectedState = getCookie(c, STATE_COOKIE);
    const codeVerifier = getCookie(c, CODE_VERIFIER_COOKIE);
    // 照合の成否によらず、使い終えた値を端末に残さない
    deleteCookie(c, STATE_COOKIE, loginCookieAttributes);
    deleteCookie(c, CODE_VERIFIER_COOKIE, loginCookieAttributes);

    const state = c.req.query("state");
    const code = c.req.query("code");
    // どちらも「あって空でない」ことを先に確かめる。ない同士を一致と見なさない
    if (!expectedState || !state || state !== expectedState) return backToApp(c, "failed", "state");
    if (!codeVerifier) return backToApp(c, "failed", "code_verifier");
    // 利用者が認可を拒んだとき（error=access_denied）も、コードがないのでここに来る
    if (!code) return backToApp(c, "failed", c.req.query("error") === undefined ? "code" : "denied");

    try {
      const accessToken = await exchangeCode(c.env, { code, codeVerifier, redirectUri: redirectUriOf(c) });
      if (accessToken === null) return backToApp(c, "failed", "token");

      const operator = await fetchOperator(c.env, accessToken);
      if (operator.kind === "no-role") return backToApp(c, "no-role");
      if (operator.kind === "failed") return backToApp(c, "failed", operator.reason);

      setSessionCookie(c, await issueSession(c.env.SESSION_SECRET, operator, Date.now()));
      return backToApp(c, "ok");
    } catch (err) {
      // Discord との通信の失敗と時間切れ。例外の文言は出さない
      return backToApp(c, "failed", err instanceof Error ? err.name : "unknown");
    }
  });

  // セッションの Cookie を消す。端末のデータの消去は受付アプリが行う（FR-37）
  // 本文は受けないので、Content-Type は求めない
  auth.post("/logout", requireSameOrigin, requireSession, (c) => {
    clearSessionCookie(c);
    return c.body(null, 204);
  });

  return auth;
}
