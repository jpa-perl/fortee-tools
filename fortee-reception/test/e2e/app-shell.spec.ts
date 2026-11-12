import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";

// アプリの殻と Service Worker（Design Doc 6.11、6.12）。
// 未ログインの画面（S01）で確かめる。ログインした後の画面は flows.spec.ts にある。

/** Service Worker が有効になるのを待つ。事前のキャッシュが終わってから、有効になる（Design Doc 6.11） */
const serviceWorkerActive = (page: Page): Promise<void> =>
  page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));

test("静的アセットと Worker が同じオリジンから返る", async ({ page, request }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("YAPC::Tokyo 2026（ローカル）");
  await expect(page).toHaveTitle("YAPC::Tokyo 2026（ローカル）");

  // /api/ と /auth/ 以下は、静的アセットより先に Worker に届く（Design Doc 7.1）
  const me = await request.get("/api/me");
  expect(me.status()).toBe(401);
  expect(await me.json()).toEqual({ error: "unauthorized" });
  const auth = await request.get("/auth/unknown");
  expect(auth.status()).toBe(404);
  expect(await auth.json()).toEqual({ error: "not_found" });

  // 一致する静的アセットがない要求も Worker に届き、404 になる
  expect((await request.get("/no-such-file")).status()).toBe(404);
});

test("根要素のフォントは、日本語のフォント名から始まる", async ({ page }) => {
  await page.goto("/");
  const fontFamily = await page.evaluate(() => getComputedStyle(document.documentElement).fontFamily);
  expect(fontFamily).toMatch(/^"?Hiragino Sans"?,/);
});

test("アクセシビリティの検査（axe-core）に違反がない", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Discord でログイン" })).toBeVisible();
  const { violations } = await new AxeBuilder({ page }).analyze();
  expect(violations).toEqual([]);
});

// Service Worker は、Chromium と WebKit の両方で確かめる。Playwright の WebKit でも、Service Worker の登録、
// 事前のキャッシュ、オフラインでの起動、版の更新が動く（試して確かめた）。WebKit でできないのは、Service Worker が
// ページを制御した後の /api/ の要求を page.route で横取りすることだけである
test.describe("Service Worker", () => {

  test("初回のインストールで、再読み込みせずにオフラインで起動できる状態になる", async ({ page }) => {
    await page.goto("/");
    // 読み込み直されると消える印。clients.claim() による controllerchange で再読み込みしないことを確かめる
    await page.evaluate(() => {
      (window as unknown as { marker: string }).marker = "kept";
    });
    await serviceWorkerActive(page);
    await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);
    expect(await page.evaluate(() => (window as unknown as { marker?: string }).marker)).toBe("kept");

    // 事前にキャッシュした一覧のすべてが、このビルドのキャッシュに入っている
    const cached = await page.evaluate(async () => {
      const name = document.querySelector<HTMLMetaElement>('meta[name="app-shell-cache"]')?.content ?? "";
      const keys = await caches.keys();
      const cache = await caches.open(name);
      const urls = (await cache.keys()).map((request) => new URL(request.url).pathname).sort();
      return { name, keys, urls };
    });
    expect(cached.keys).toEqual([cached.name]);
    expect(cached.urls).toContain("/");
    expect(cached.urls).toContain("/manifest.webmanifest");
    // ホーム画面のアイコンも、殻に含める
    expect(cached.urls).toContain("/icon-192.png");
    expect(cached.urls).toContain("/apple-touch-icon.png");
    expect(cached.urls.some((url) => url.endsWith(".js"))).toBe(true);
    expect(cached.urls.some((url) => url.endsWith(".css"))).toBe(true);
    // Service Worker 自身と、Worker の出力は入らない
    expect(cached.urls).not.toContain("/sw.js");
    expect(cached.urls.some((url) => url.includes("wrangler"))).toBe(false);
  });

  test("オフラインで起動でき、クエリ付きのページ遷移にも殻を返す", async ({ page, context }) => {
    await page.goto("/");
    await serviceWorkerActive(page);

    await context.setOffline(true);
    await page.reload();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("YAPC::Tokyo 2026（ローカル）");
    await expect(page.getByRole("button", { name: "Discord でログイン" })).toBeVisible();

    // Discord から /?login=... 付きで戻ったときも、殻を返す。オフラインでは操作者の情報を取得できないので、
    // 未ログインに戻って「ログインできませんでした」を出す（画面設計書 S01）
    await page.goto("/?login=ok");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("YAPC::Tokyo 2026（ローカル）");
    await expect(page.getByText("ログインできませんでした")).toBeVisible();
  });

  test("/api/ と /auth/ 以下の要求には、キャッシュから答えない", async ({ page, context }) => {
    await page.goto("/");
    await serviceWorkerActive(page);

    const online = await page.evaluate(async () => (await fetch("/api/me")).status);
    expect(online).toBe(401);

    await context.setOffline(true);
    const offline = await page.evaluate(() =>
      fetch("/api/me").then(
        (response) => `status ${response.status}`,
        () => "network error",
      ),
    );
    expect(offline).toBe("network error");
  });
});
