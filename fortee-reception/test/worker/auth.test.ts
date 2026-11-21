import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { meResponseSchema } from "../../src/core/sync.ts";
import { CODE_VERIFIER_COOKIE, STATE_COOKIE } from "../../src/worker/routes/auth.ts";
import { SESSION_COOKIE } from "../../src/worker/session.ts";
import { ORIGIN, request } from "./helpers.ts";

// Discord のログイン（Design Doc 7.2）。Discord への実通信はせず、fetch を差し替える。
// 差し替えた fetch は、Discord の決まった URL のほかには答えない

// 差し替えを置かないテストでも、外への通信は失敗させる
beforeEach(() => {
  vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
    throw new Error(`テストが想定しない通信: ${new Request(input).url}`);
  });
});
afterEach(() => vi.restoreAllMocks());

const STAFF_ROLE = "test-role-2";
const ACCESS_TOKEN = "discord-access-token-secret";
const CODE = "discord-code-secret";

/** 応答を作る関数。応答の本文は、それを読む要求の中で作らなければならないので、作り置きしない */
type Reply = () => Response;
type Discord = { token?: Reply; user?: Reply; member?: Reply };

const json =
  (body: unknown, status = 200): Reply =>
  () =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const defaultUser = { id: "123456789012345678", username: "user_name", global_name: "グローバル名" };
const defaultMember = { nick: "ニックネーム", roles: ["other-role", STAFF_ROLE] };

/** Discord の API を差し替える。呼ばれた要求を記録して返す */
function stubDiscord(discord: Discord = {}) {
  const calls: { url: string; method: string; headers: Headers; body: string }[] = [];

  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const req = new Request(input, init);
    calls.push({ url: req.url, method: req.method, headers: req.headers, body: new TextDecoder().decode(await req.arrayBuffer()) });
    switch (req.url) {
      case "https://discord.com/api/v10/oauth2/token":
        return (discord.token ?? json({ access_token: ACCESS_TOKEN, token_type: "Bearer" }))();
      case "https://discord.com/api/v10/users/@me":
        return (discord.user ?? json(defaultUser))();
      case `https://discord.com/api/v10/users/@me/guilds/${env.DISCORD_GUILD_ID}/member`:
        return (discord.member ?? json(defaultMember))();
      default:
        throw new Error(`テストが想定しない通信: ${req.url}`);
    }
  });
  return calls;
}

function cookieValue(cookies: string[], name: string): string | undefined {
  const cookie = cookies.find((c) => c.startsWith(`${name}=`));
  return cookie === undefined ? undefined : decodeURIComponent(cookie.slice(name.length + 1, cookie.indexOf(";")));
}

async function sha256Base64Url(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return btoa(String.fromCharCode(...digest)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

/** 認可を始めて、置かれた Cookie の値と認可 URL を返す */
async function start() {
  const res = await request("/auth/discord/start");
  const cookies = res.headers.getSetCookie();
  return {
    res,
    cookies,
    state: cookieValue(cookies, STATE_COOKIE)!,
    codeVerifier: cookieValue(cookies, CODE_VERIFIER_COOKIE)!,
    location: new URL(res.headers.get("Location")!),
  };
}

function callback(query: Record<string, string>, cookies: Record<string, string>, headers: Record<string, string> = {}) {
  const cookie = Object.entries(cookies)
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");
  return request(`/auth/discord/callback?${new URLSearchParams(query)}`, {
    headers: { ...(cookie === "" ? {} : { Cookie: cookie }), ...headers },
  });
}

/** コールバックの応答が、state と code_verifier の Cookie を消していること */
function expectLoginCookiesCleared(res: Response) {
  const cookies = res.headers.getSetCookie();
  for (const name of [STATE_COOKIE, CODE_VERIFIER_COOKIE]) {
    const cookie = cookies.find((c) => c.startsWith(`${name}=`));
    expect(cookie, name).toBeDefined();
    expect(cookie).toMatch(new RegExp(`^${name}=;`));
    expect(cookie).toMatch(/Max-Age=0/);
    expect(cookie).toMatch(/Path=\//);
    expect(cookie).toMatch(/Secure/);
    expect(cookie).not.toMatch(/Domain=/i);
  }
}

function expectRedirect(res: Response, login: string) {
  expect(res.status).toBe(302);
  expect(res.headers.get("Location")).toBe(`/?login=${login}`);
}

const sessionOf = (res: Response) => cookieValue(res.headers.getSetCookie(), SESSION_COOKIE);

describe("認可の開始（Design Doc 7.2）", () => {
  it("state と code_verifier の Cookie を、__Host- 接頭辞と Path=/ で、Domain を付けずに置く", async () => {
    const { res, cookies, state, codeVerifier } = await start();
    expect(res.status).toBe(302);
    expect(cookies).toHaveLength(2);
    for (const name of ["__Host-state", "__Host-code_verifier"]) {
      const cookie = cookies.find((c) => c.startsWith(`${name}=`));
      expect(cookie, name).toBeDefined();
      expect(cookie).toMatch(/Path=\/(;|$)/);
      expect(cookie).toMatch(/Max-Age=600/);
      expect(cookie).toMatch(/HttpOnly/);
      expect(cookie).toMatch(/Secure/);
      expect(cookie).toMatch(/SameSite=Lax/);
      expect(cookie).not.toMatch(/Domain=/i);
    }
    // code_verifier は 43〜128 文字の、予約されていない文字（RFC 7636 の 4.1）
    expect(codeVerifier).toMatch(/^[0-9A-Za-z._~-]{43,128}$/);
    expect(state.length).toBeGreaterThanOrEqual(32);
    expect(state).not.toBe(codeVerifier);
  });

  it("認可 URL に、スコープ、state、リダイレクト URI、code_challenge（S256）を付ける", async () => {
    const { state, codeVerifier, location } = await start();
    expect(`${location.origin}${location.pathname}`).toBe("https://discord.com/oauth2/authorize");
    expect(Object.fromEntries(location.searchParams)).toEqual({
      response_type: "code",
      client_id: env.DISCORD_CLIENT_ID,
      scope: "identify guilds.members.read",
      state,
      redirect_uri: `${ORIGIN}/auth/discord/callback`,
      code_challenge: await sha256Base64Url(codeVerifier),
      code_challenge_method: "S256",
    });
    // code_verifier とクライアントシークレットは、認可 URL に出さない
    expect(location.href).not.toContain(codeVerifier);
    expect(location.href).not.toContain(env.DISCORD_CLIENT_SECRET);
  });

  it("始めるたびに、違う state と code_verifier を作る", async () => {
    const [a, b] = [await start(), await start()];
    expect(a.state).not.toBe(b.state);
    expect(a.codeVerifier).not.toBe(b.codeVerifier);
  });
});

describe("コールバック（Design Doc 7.1、7.2）", () => {
  const cookies = { [STATE_COOKIE]: "state-value", [CODE_VERIFIER_COOKIE]: "v".repeat(43) };
  const query = { code: CODE, state: "state-value" };

  it("トークンの交換に code_verifier を付け、セッションを発行して、Cookie を消す", async () => {
    const calls = stubDiscord();
    const started = await start();
    const res = await callback(
      { code: CODE, state: started.state },
      { [STATE_COOKIE]: started.state, [CODE_VERIFIER_COOKIE]: started.codeVerifier },
      // Discord からの画面の遷移で届く
      { "Sec-Fetch-Site": "cross-site" },
    );

    expectRedirect(res, "ok");
    expectLoginCookiesCleared(res);

    const token = calls.find((c) => c.url.endsWith("/oauth2/token"))!;
    expect(token.method).toBe("POST");
    expect(token.headers.get("Content-Type")).toMatch(/^application\/x-www-form-urlencoded/);
    expect(Object.fromEntries(new URLSearchParams(token.body))).toEqual({
      grant_type: "authorization_code",
      code: CODE,
      redirect_uri: `${ORIGIN}/auth/discord/callback`,
      client_id: env.DISCORD_CLIENT_ID,
      client_secret: env.DISCORD_CLIENT_SECRET,
      code_verifier: started.codeVerifier,
    });
    // ユーザとギルドのメンバー情報を、受け取ったトークンで取る
    const others = calls.filter((c) => c !== token);
    expect(others.map((c) => c.url).sort()).toEqual([
      "https://discord.com/api/v10/users/@me",
      `https://discord.com/api/v10/users/@me/guilds/${env.DISCORD_GUILD_ID}/member`,
    ]);
    for (const call of others) expect(call.headers.get("Authorization")).toBe(`Bearer ${ACCESS_TOKEN}`);

    // 発行したセッションで、操作者を読める
    const sessionCookie = res.headers.getSetCookie().find((c) => c.startsWith(`${SESSION_COOKIE}=`))!;
    expect(sessionCookie).toMatch(/Max-Age=604800/);
    expect(sessionCookie).toMatch(/Path=\//);
    expect(sessionCookie).toMatch(/HttpOnly/);
    expect(sessionCookie).toMatch(/Secure/);
    expect(sessionCookie).toMatch(/SameSite=Lax/);
    expect(sessionCookie).not.toMatch(/Domain=/i);
    const me = await request("/api/me", { session: sessionOf(res)! });
    expect(meResponseSchema.parse(await me.json())).toEqual({
      operatorId: defaultUser.id,
      operatorName: "ニックネーム",
    });
  });

  it("表示名は、ニックネーム、グローバルな表示名、ユーザ名の順で最初にあるものにする", async () => {
    const nameWith = async (member: object, user: object) => {
      stubDiscord({ member: json({ roles: [STAFF_ROLE], ...member }), user: json({ ...defaultUser, ...user }) });
      const res = await callback(query, cookies);
      expectRedirect(res, "ok");
      const me = await request("/api/me", { session: sessionOf(res)! });
      return ((await me.json()) as { operatorName: string }).operatorName;
    };
    expect(await nameWith({ nick: "ニックネーム" }, {})).toBe("ニックネーム");
    expect(await nameWith({ nick: null }, {})).toBe("グローバル名");
    expect(await nameWith({}, { global_name: null })).toBe("user_name");
    expect(await nameWith({ nick: "" }, { global_name: "" })).toBe("user_name");
  });

  it("設定されたロールのどれかを持てば通し、どれも持たなければ no-role にする", async () => {
    for (const roles of [["test-role-1"], ["test-role-2", "x"]]) {
      stubDiscord({ member: json({ roles }) });
      expectRedirect(await callback(query, cookies), "ok");
    }
    for (const member of [{ roles: [] }, { roles: ["other-role"] }, { roles: ["test-role"] }, {}]) {
      stubDiscord({ member: json(member) });
      const res = await callback(query, cookies);
      expectRedirect(res, "no-role");
      expectLoginCookiesCleared(res);
      expect(sessionOf(res)).toBeUndefined();
    }
  });

  it("ギルドのメンバーでなければ（404）、no-role にする", async () => {
    stubDiscord({ member: json({ message: "Unknown Guild", code: 10004 }, 404) });
    const res = await callback(query, cookies);
    expectRedirect(res, "no-role");
    expect(sessionOf(res)).toBeUndefined();
  });

  it("state が合わないか、Cookie かクエリが欠けていれば、Discord を呼ばずに failed にして、Cookie を消す", async () => {
    const calls = stubDiscord();
    const cases: [Record<string, string>, Record<string, string>][] = [
      [{ code: CODE, state: "another" }, cookies],
      [{ code: CODE }, cookies],
      // ない同士を、一致と見なさない
      [{ code: CODE }, {}],
      [{ code: CODE }, { [CODE_VERIFIER_COOKIE]: "v".repeat(43) }],
      [{ code: CODE, state: "" }, { [STATE_COOKIE]: "", [CODE_VERIFIER_COOKIE]: "v".repeat(43) }],
      [query, {}],
      [query, { [STATE_COOKIE]: "state-value" }],
      [query, { [CODE_VERIFIER_COOKIE]: "v".repeat(43) }],
      // 接頭辞のない名前の Cookie は読まない
      [query, { state: "state-value", code_verifier: "v".repeat(43) }],
      [{ state: "state-value" }, cookies],
      // 利用者が認可を拒んだ
      [{ state: "state-value", error: "access_denied" }, cookies],
    ];
    for (const [q, c] of cases) {
      const res = await callback(q, c);
      expectRedirect(res, "failed");
      expectLoginCookiesCleared(res);
      expect(sessionOf(res)).toBeUndefined();
    }
    expect(calls).toEqual([]);
  });

  it("Discord の失敗は failed にして、セッションを発行しない", async () => {
    const networkError: Reply = () => {
      throw new TypeError("network");
    };
    // 失敗の内容と、ログに出る理由の語
    const failures: [Discord, string][] = [
      [{ token: json({ error: "invalid_grant" }, 400) }, "token"],
      [{ token: json({ token_type: "Bearer" }) }, "token"],
      [{ token: networkError }, "TypeError"],
      [{ user: json({ message: "401: Unauthorized" }, 401) }, "user"],
      // 記録の操作者の形（数字の ID、名前）に合わない
      [{ user: json({ id: "not-a-number", username: "x" }) }, "operator"],
      [{ user: json({ id: "1" }), member: json({ roles: [STAFF_ROLE] }) }, "operator"],
      // 保存して読み戻すと変わる文字（対になっていないサロゲート）を持つ名前。記録の操作者名にできない
      [{ member: json({ nick: "abc\ud83c", roles: [STAFF_ROLE] }) }, "operator"],
      [{ member: json({ message: "rate limited" }, 429) }, "member"],
      [{ member: json({}, 500) }, "member"],
      [{ member: networkError }, "TypeError"],
    ];
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    for (const [failure, reason] of failures) {
      stubDiscord(failure);
      const res = await callback(query, cookies);
      expectRedirect(res, "failed");
      expectLoginCookiesCleared(res);
      expect(sessionOf(res)).toBeUndefined();
      expect(JSON.parse(String(log.mock.lastCall?.[0]))).toMatchObject({ login: "failed", reason });
    }
  });

  it("認可コード、トークン、state、Cookie をログに出さない", async () => {
    stubDiscord();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await callback(query, cookies);
    stubDiscord({ token: json({ error: "invalid_grant" }, 400) });
    await callback(query, cookies);

    const lines = log.mock.calls.map((args) => String(args[0]));
    expect(lines.map((l) => JSON.parse(l) as unknown)).toEqual([
      { route: "/auth/discord/callback", method: "GET", status: 302, login: "ok", ms: expect.any(Number) },
      { route: "/auth/discord/callback", method: "GET", status: 302, login: "failed", reason: "token", ms: expect.any(Number) },
    ]);
    for (const secret of [CODE, ACCESS_TOKEN, "state-value", "v".repeat(43), env.DISCORD_CLIENT_SECRET]) {
      expect(lines.join("\n")).not.toContain(secret);
    }
  });
});
