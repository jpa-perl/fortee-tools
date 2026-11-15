import { devices, expect, test } from "@playwright/test";
import { addSessionCookie, expectNoA11yViolations, login, OPERATOR, scanButton, shot } from "./helpers.ts";
import { E2E_HOST } from "./setup/data.ts";

// 開き方の案内（S00）、ログイン（S01）の状態、2 つの画面の重なり（Design Doc 6.4、NFR-8、9）。

test("S01: HTTPS で Secure Cookie を送り、同期で更新された Cookie でも認証できる", async ({ page, context, baseURL }) => {
  if (baseURL === undefined) throw new Error("baseURL がない");
  await addSessionCookie(context, baseURL);
  const original = (await context.cookies(baseURL)).find((cookie) => cookie.name === "__Host-session");
  expect(original).toBeDefined();

  await page.goto("/?login=ok");
  expect(new URL(page.url()).protocol).toBe("https:");
  expect(new URL(page.url()).hostname).toBe(E2E_HOST);
  await expect(scanButton(page)).toBeVisible();
  // テストで置いた Cookie は残り 1 日なので、初回の同期でサーバが有効期限を延ばして発行し直す。
  // addCookies で置けるだけでなく、Set-Cookie をブラウザが受け入れることも確かめる。
  await expect.poll(async () => {
    const renewed = (await context.cookies(baseURL)).find((cookie) => cookie.name === "__Host-session");
    return renewed !== undefined && renewed.value !== original?.value;
  }).toBe(true);
  expect((await context.cookies(baseURL)).find((cookie) => cookie.name === "__Host-session")).toMatchObject({
    domain: new URL(baseURL).hostname,
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "Lax",
  });
  // APIRequestContext ではなく、ページからの実際の要求で更新後の Cookie の送信を確かめる。
  const me = await page.evaluate(async () => {
    const response = await fetch("/api/me");
    return { status: response.status, body: await response.json() as unknown };
  });
  expect(me).toEqual({ status: 200, body: { operatorId: OPERATOR.sub, operatorName: OPERATOR.name } });
});

test("S00: iOS の Safari のタブで開くと、ホーム画面への追加を案内して、先へ進ませない", async ({ browser, baseURL }, testInfo) => {
  // iPhone の UA とタッチを名乗る。ホーム画面の Web アプリではない（navigator.standalone がない）
  const { userAgent } = devices["iPhone 15"];
  const context = await browser.newContext({ userAgent, hasTouch: true, viewport: testInfo.project.use.viewport ?? null });
  const page = await context.newPage();
  try {
    await page.goto(baseURL ?? "/");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("ホーム画面に追加して開いてください");
    await expect(page.getByText("①「共有」ボタン")).toBeVisible();
    await expect(page.getByText("②「ホーム画面に追加」")).toBeVisible();
    await expect(page.getByText("③ ホーム画面のアイコンから開く")).toBeVisible();
    await expect(page.getByRole("button")).toHaveCount(0);
    await expectNoA11yViolations(page);
    await shot(page, testInfo, "s00");
  } finally {
    await context.close();
  }
});

test("S00: 同じ端末の別の画面がログイン済みで動いていると、後から開いた画面は止まる", async ({ page, context, baseURL }, testInfo) => {
  // 記録は作らないので、オンラインのままにする
  await login(page, baseURL, { offline: false });

  // 2 つ目の画面。先に開いていた画面は止めず、後から開いた画面を止める
  const second = await context.newPage();
  await second.goto("/");
  await expect(second.getByRole("heading", { level: 1 })).toHaveText("別の画面で開いています");
  await expect(second.getByText("ホーム画面のアプリかほかのタブで開いているので、このタブは閉じてください")).toBeVisible();
  await expectNoA11yViolations(second);
  await shot(second, testInfo, "s00-other-tab");
  await expect(scanButton(page)).toBeVisible();

  // ほかの画面が開いている間は、「再読み込み」でも進まない。自動でも進まない
  await second.getByRole("button", { name: "再読み込み" }).click();
  await expect(second.getByRole("heading", { level: 1 })).toHaveText("別の画面で開いています");

  // ほかの画面を閉じて「再読み込み」を押すと、起動をやり直して、停止中に着く
  await page.close();
  await expect(second.getByRole("heading", { level: 1 })).toHaveText("別の画面で開いています");
  await second.getByRole("button", { name: "再読み込み" }).click();
  await expect(scanButton(second)).toBeVisible();
});

test("S00: ログインしていない画面は、ほかの画面を止めない", async ({ page, context, baseURL }) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Discord でログイン" })).toBeVisible();
  const second = await context.newPage();
  await login(second, baseURL, { offline: false });
  await expect(page.getByRole("button", { name: "Discord でログイン" })).toBeVisible();
});

test("S01: ログインに失敗して戻ると、未ログインに「ログインできませんでした」を出す", async ({ page }, testInfo) => {
  await page.goto("/?login=failed");
  await expect(page.getByText("ログインできませんでした")).toBeVisible();
  await expect(page.getByRole("button", { name: "Discord でログイン" })).toBeVisible();
  // 端末にデータがないので、「戻る」は置かない
  await expect(page.getByRole("button", { name: "戻る" })).toHaveCount(0);
  // 戻った URL の印は消す
  expect(new URL(page.url()).search).toBe("");
  await expectNoA11yViolations(page);
  await shot(page, testInfo, "s01-login-failed");
});

test("S01: ロールがないと、別のアカウントでのログインを求める", async ({ page }, testInfo) => {
  await page.goto("/?login=no-role");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("このアカウントでは使えません");
  await expect(page.getByRole("button", { name: "別のアカウントでログイン" })).toBeVisible();
  await expectNoA11yViolations(page);
  await shot(page, testInfo, "s01-no-role");
});

test("S01: 再ログインに失敗しても、「戻る」で受付を続けられる", async ({ page, baseURL }) => {
  await login(page, baseURL, { offline: false });

  // 端末にデータがある画面に、Discord からロールなしで戻った
  await page.goto("/?login=no-role");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("このアカウントでは使えません");
  await page.getByRole("button", { name: "戻る" }).click();
  await expect(scanButton(page)).toBeVisible();

  // 失敗で戻ったときも同じ
  await page.goto("/?login=failed");
  await expect(page.getByText("ログインできませんでした")).toBeVisible();
  await page.getByRole("button", { name: "戻る" }).click();
  await expect(scanButton(page)).toBeVisible();
});

test("S01: セッションがないまま Discord から戻ると、未ログインに戻る", async ({ page }) => {
  await page.goto("/?login=ok");
  await expect(page.getByText("ログインできませんでした")).toBeVisible();
});

test("S02: ログイン済みの端末は、開き直すと、ログインをやり直さずに停止中に着く", async ({ page, context, baseURL }) => {
  if (baseURL === undefined) throw new Error("baseURL がない");
  await addSessionCookie(context, baseURL);
  await page.goto("/?login=ok");
  await expect(scanButton(page)).toBeVisible();
  await page.reload();
  await expect(scanButton(page)).toBeVisible();
  await expect(page.getByRole("button", { name: "受付を切り替える" })).toContainText("本編受付");
});

test.describe("S01: データの取得の失敗", () => {
  // 同期の応答を差し替える。Playwright の WebKit は、Service Worker がページを制御した後の /api/ を横取りしない
  test.skip(({ browserName }) => browserName !== "chromium", "応答の差し替えは Chromium で確かめる");

  test("データを取得できなければ、取得失敗を出し、「再試行」で取り直す", async ({ page, context, baseURL }, testInfo) => {
    if (baseURL === undefined) throw new Error("baseURL がない");
    await page.route("**/api/sync", (route) => route.abort());
    await addSessionCookie(context, baseURL);
    await page.goto("/?login=ok");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("データを取得できませんでした");
    await expect(scanButton(page)).toHaveCount(0);
    await expectNoA11yViolations(page);
    await shot(page, testInfo, "s01-fetch-failed");

    // まだ取得できなければ、取得失敗のまま
    await page.getByRole("button", { name: "再試行" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("データを取得できませんでした");

    // 取得できるようになってから「再試行」を押すと、停止中に着く
    await page.unroute("**/api/sync");
    await page.getByRole("button", { name: "再試行" }).click();
    await expect(scanButton(page)).toBeVisible();
  });

  test("ログインの期限が切れていれば、再試行ではなく、再ログインを求める", async ({ page, context, baseURL }, testInfo) => {
    if (baseURL === undefined) throw new Error("baseURL がない");
    await page.route("**/api/sync", (route) =>
      route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ error: "unauthorized" }) }),
    );
    await addSessionCookie(context, baseURL);
    await page.goto("/?login=ok");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("ログインの期限が切れました。もう一度ログインしてください");
    await expect(page.getByRole("button", { name: "Discord でログイン" })).toBeVisible();
    // S02 に戻るためのデータがまだないので、「戻る」も「再試行」も置かない
    await expect(page.getByRole("button", { name: "戻る" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "再試行" })).toHaveCount(0);
    await expectNoA11yViolations(page);
    await shot(page, testInfo, "s01-needs-login");
  });
});
