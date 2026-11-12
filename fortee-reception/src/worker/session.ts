import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import type { AppEnv } from "./env.ts";
import { errorResponse } from "./errors.ts";

// セッション（Design Doc 7.2）。サーバに状態を持たない署名付き Cookie。
// 形式は base64url(JSON) と、その HMAC-SHA256 を「.」でつないだもの。検証は署名と exp だけを見て、DB は読まない。

/**
 * Cookie の名前。__Host- 接頭辞を付ける。この接頭辞の付いた Cookie は、Secure と Path=/ が要り、
 * Domain 属性を持てないので、同じサイトのほかのホスト（workers.dev の同じアカウントのほかの Worker）が、
 * このオリジンに届く同じ名前の Cookie を置くことができない
 */
export const SESSION_COOKIE = "__Host-session";
/** セッションの期限。同期のたびに延ばす */
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** 期限までの残りがこれを切っていれば、同期の応答で発行し直す。端末 1 台につき 1 日に 1 回ほどになる */
export const SESSION_RENEW_BELOW_MS = 6 * 24 * 60 * 60 * 1000;

export type Session = {
  /** Discord のユーザ ID */
  sub: string;
  /** Discord の表示名 */
  name: string;
  /** 期限。エポックミリ秒 */
  exp: number;
};

export type SessionEnv = { Bindings: AppEnv["Bindings"]; Variables: AppEnv["Variables"] & { session: Session } };

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** バイト列を、詰め物のない base64url にする。セッションの値と、ログインの途中の乱数と code_challenge に使う */
export function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function fromBase64Url(text: string): Uint8Array | null {
  if (!/^[0-9A-Za-z_-]*$/.test(text)) return null;
  try {
    const binary = atob(text.replaceAll("-", "+").replaceAll("_", "/"));
    return Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
  } catch {
    return null;
  }
}

function hmacKey(secret: string): Promise<CryptoKey> {
  // 秘密が設定されていない Worker では、署名も検証もしない（500 になる）
  if (typeof secret !== "string" || secret === "") throw new Error("SESSION_SECRET is not set");
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

export async function signSession(secret: string, session: Session): Promise<string> {
  const payload = toBase64Url(encoder.encode(JSON.stringify(session)));
  const signature = await crypto.subtle.sign("HMAC", await hmacKey(secret), encoder.encode(payload));
  return `${payload}.${toBase64Url(new Uint8Array(signature))}`;
}

/** 署名と期限を確かめる。合わなければ null */
export async function verifySession(secret: string, token: string, now: number): Promise<Session | null> {
  const [payload, signature, ...rest] = token.split(".");
  if (payload === undefined || signature === undefined || rest.length > 0) return null;
  const signatureBytes = fromBase64Url(signature);
  if (signatureBytes === null) return null;

  const valid = await crypto.subtle.verify("HMAC", await hmacKey(secret), signatureBytes, encoder.encode(payload));
  if (!valid) return null;

  // 署名が合っていれば、この Worker が発行した値である
  const payloadBytes = fromBase64Url(payload);
  if (payloadBytes === null) return null;
  const session = JSON.parse(decoder.decode(payloadBytes)) as Session;
  if (typeof session.exp !== "number" || session.exp <= now) return null;
  return session;
}

/** 期限を now から 7 日後にしたセッションを発行する */
export function issueSession(secret: string, operator: { sub: string; name: string }, now: number): Promise<string> {
  return signSession(secret, { sub: operator.sub, name: operator.name, exp: now + SESSION_TTL_MS });
}

export function setSessionCookie(c: Context, token: string): void {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/",
    maxAge: SESSION_TTL_MS / 1000,
  });
}

export function clearSessionCookie(c: Context): void {
  deleteCookie(c, SESSION_COOKIE, { httpOnly: true, secure: true, sameSite: "Lax", path: "/" });
}

/**
 * 期限までの残りが短ければ、sub と name はそのままに、期限を now から 7 日後にしたトークンを発行し直して、
 * 同じ属性の Cookie で返す。exp は署名した JSON の中にあるので、Cookie の Max-Age を延ばすだけでは足りない。
 * DB も Discord も読まない。発行し直したら true
 */
export async function renewSessionIfNeeded(c: Context<SessionEnv>, now: number): Promise<boolean> {
  const session = c.get("session");
  if (session.exp - now >= SESSION_RENEW_BELOW_MS) return false;
  setSessionCookie(c, await issueSession(c.env.SESSION_SECRET, session, now));
  return true;
}

/** セッションを検証するミドルウェア。ないか期限切れなら 401 を返す（Design Doc 7.1） */
export const requireSession = createMiddleware<SessionEnv>(async (c, next) => {
  const token = getCookie(c, SESSION_COOKIE);
  const session = token === undefined ? null : await verifySession(c.env.SESSION_SECRET, token, Date.now());
  if (session === null) return errorResponse(c, "unauthorized");
  c.set("session", session);
  await next();
});
