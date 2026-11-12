import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { meResponseSchema } from "../../src/core/sync.ts";
import { issueSession, SESSION_COOKIE, signSession } from "../../src/worker/session.ts";

const ORIGIN = "https://checkin.test";
const operator = { sub: "123456789012345678", name: "受付 太郎" };

function request(path: string, init: RequestInit & { session?: string } = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (init.session !== undefined) headers.set("Cookie", `${SESSION_COOKIE}=${init.session}`);
  return exports.default.fetch(new Request(`${ORIGIN}${path}`, { ...init, headers }));
}

const validSession = () => issueSession(env.SESSION_SECRET, operator, Date.now());

describe("テストの構成（Design Doc 11 章、12.2）", () => {
  it("ローカルの D1 にマイグレーションが適用されている", async () => {
    const { results } = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('records', 'devices', 'meta') ORDER BY name",
    ).all<{ name: string }>();
    expect(results.map((r) => r.name)).toEqual(["devices", "meta", "records"]);
  });

  it("マイグレーションが世代の初期値を入れる（Design Doc 7.3）", async () => {
    const row = await env.DB.prepare("SELECT value FROM meta WHERE key = 'generation'").first<{ value: string }>();
    expect(row?.value).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe("エラー応答（Design Doc 7.6）", () => {
  it("知らないパスに 404 を JSON で返す", async () => {
    for (const path of ["/unknown", "/auth/unknown"]) {
      const res = await request(path);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "not_found" });
    }
  });

  it("/api/ 以下の知らないパスは、セッションがあれば 404、なければ 401", async () => {
    expect((await request("/api/unknown")).status).toBe(401);
    const res = await request("/api/unknown", { session: await validSession() });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });
});

describe("セッション（Design Doc 7.2）", () => {
  it("セッションがなければ 401", async () => {
    const res = await request("/api/me");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("セッションの操作者を返す", async () => {
    const res = await request("/api/me", { session: await validSession() });
    expect(res.status).toBe(200);
    expect(meResponseSchema.parse(await res.json())).toEqual({
      operatorId: operator.sub,
      operatorName: operator.name,
    });
  });

  it("期限切れのセッションは 401", async () => {
    const expired = await signSession(env.SESSION_SECRET, { ...operator, exp: Date.now() - 1 });
    expect((await request("/api/me", { session: expired })).status).toBe(401);
  });

  it("別の秘密で署名したセッションは 401", async () => {
    const forged = await issueSession("another-secret", operator, Date.now());
    expect((await request("/api/me", { session: forged })).status).toBe(401);
  });

  it("書き換えたセッションは 401", async () => {
    const token = await validSession();
    const [, signature] = token.split(".");
    const payload = btoa(JSON.stringify({ sub: "999", name: "x", exp: Date.now() + 60_000 })).replaceAll("=", "");
    for (const tampered of [`${payload}.${signature}`, `${token}x`, "", ".", "a.b.c", "%%%.%%%"]) {
      expect((await request("/api/me", { session: tampered })).status).toBe(401);
    }
  });

  it("ログアウトはセッションの Cookie を消す", async () => {
    const res = await request("/auth/logout", { method: "POST", session: await validSession() });
    expect(res.status).toBe(204);
    const cookie = res.headers.get("Set-Cookie") ?? "";
    expect(cookie).toMatch(/^__Host-session=;/);
    expect(cookie).toMatch(/Path=\//);
    expect(cookie).not.toMatch(/Domain=/i);
    expect(cookie).toMatch(/Max-Age=0/);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/Secure/);
    expect(cookie).toMatch(/SameSite=Lax/);
  });

  it("接頭辞のない名前の Cookie は、セッションとして読まない", async () => {
    const res = await request("/api/me", { headers: { Cookie: `session=${await validSession()}` } });
    expect(res.status).toBe(401);
  });

  it("セッションのないログアウトは 401", async () => {
    expect((await request("/auth/logout", { method: "POST" })).status).toBe(401);
  });
});

describe("配布物の配信（Design Doc 7.4）", () => {
  const config = JSON.stringify({ format: 0, version: 1764100000000 });
  const snapshot = JSON.stringify({ format: 0, eventId: "ev-1", version: 1764200000000, attendees: [] });

  it("KV の設定とスナップショットを、共有キャッシュに置かせずに返す", async () => {
    await env.KV.put("config:1764100000000", config);
    await env.KV.put("snapshot:ev-1:1764200000000", snapshot);
    const session = await validSession();

    for (const [path, body] of [
      ["/api/config/1764100000000", config],
      ["/api/snapshot/ev-1/1764200000000", snapshot],
    ] as const) {
      const res = await request(path, { session });
      expect(res.status).toBe(200);
      expect(res.headers.get("Cache-Control")).toBe("private, no-store");
      expect(res.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
      expect(await res.text()).toBe(body);
    }
  });

  it("KV にない版は 404", async () => {
    const session = await validSession();
    for (const path of ["/api/config/1", "/api/snapshot/ev-1/1", "/api/config/latest", "/api/snapshot/a:b/1"]) {
      const res = await request(path, { session });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "not_found" });
    }
  });

  it("セッションがなければ配らない", async () => {
    await env.KV.put("config:1764100000000", config);
    expect((await request("/api/config/1764100000000")).status).toBe(401);
  });
});

describe("同じオリジンの照合（Design Doc 7.1、9.3）", () => {
  const me = (headers: Record<string, string>, session = true) =>
    validSession().then((token) => request("/api/me", session ? { headers, session: token } : { headers }));
  const logout = (headers: Record<string, string>) =>
    validSession().then((token) => request("/auth/logout", { method: "POST", headers, session: token }));

  it("同じサイトの別のホストと、ほかのサイトからの要求を拒む", async () => {
    for (const site of ["same-site", "cross-site"]) {
      const res = await me({ "Sec-Fetch-Site": site });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "forbidden" });
      expect((await logout({ "Sec-Fetch-Site": site })).status).toBe(403);
    }
  });

  it("同じオリジンからの要求を通す", async () => {
    expect((await me({ "Sec-Fetch-Site": "same-origin" })).status).toBe(200);
    expect((await logout({ "Sec-Fetch-Site": "same-origin" })).status).toBe(204);
  });

  it("利用者が直接開いた要求（none）は、状態を変えない要求に限って通す", async () => {
    expect((await me({ "Sec-Fetch-Site": "none" })).status).toBe(200);
    expect((await logout({ "Sec-Fetch-Site": "none" })).status).toBe(403);
  });

  it("Sec-Fetch-Site がなければ、Origin を自分のオリジンと照合する", async () => {
    expect((await me({ Origin: ORIGIN })).status).toBe(200);
    expect((await logout({ Origin: ORIGIN })).status).toBe(204);
    for (const origin of ["https://other.checkin.test", "https://evil.example", "http://checkin.test", "null"]) {
      expect((await me({ Origin: origin })).status).toBe(403);
      expect((await logout({ Origin: origin })).status).toBe(403);
    }
  });

  it("どちらのヘッダもない要求（ブラウザでないクライアント）は通す", async () => {
    expect((await me({})).status).toBe(200);
  });

  it("オリジンの照合は、セッションの検証より先に行う", async () => {
    expect((await me({ "Sec-Fetch-Site": "cross-site" }, false)).status).toBe(403);
  });

  it("本文を受ける /api/ の要求には、Content-Type: application/json を求める", async () => {
    const session = await validSession();
    const post = (contentType: string | undefined) =>
      request("/api/unknown", {
        method: "POST",
        session,
        body: "{}",
        headers: contentType === undefined ? {} : { "Content-Type": contentType },
      });

    // フォームから送れる Content-Type では、JSON の本文でも受けない
    for (const contentType of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data"]) {
      const res = await post(contentType);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "bad_request" });
    }
    // 知らないパスなので 404。Content-Type の検査は通っている
    expect((await post("application/json")).status).toBe(404);
    expect((await post("application/json; charset=utf-8")).status).toBe(404);
  });
});
