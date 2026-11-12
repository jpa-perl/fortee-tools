import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

// アプリの殻と Service Worker（Design Doc 6.11、6.12）。
// 画面設計書の画面はまだないので、基盤の仮の画面で確かめる。

const offlineReady = "オフラインで起動できます";

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
  await expect(page.getByTestId("offline-ready")).not.toHaveText("確認中");
  const { violations } = await new AxeBuilder({ page }).analyze();
  expect(violations).toEqual([]);
});

test.describe("Service Worker", () => {
  test.skip(({ browserName }) => browserName !== "chromium", "Service Worker は Chromium で確かめる（Design Doc 11 章）");

  test("初回のインストールで、再読み込みせずにオフラインで起動できる状態になる", async ({ page }) => {
    await page.goto("/");
    // 読み込み直されると消える印。clients.claim() による controllerchange で再読み込みしないことを確かめる
    await page.evaluate(() => {
      (window as unknown as { marker: string }).marker = "kept";
    });
    await expect(page.getByTestId("offline-ready")).toHaveText(offlineReady);
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
    expect(cached.urls.some((url) => url.endsWith(".js"))).toBe(true);
    expect(cached.urls.some((url) => url.endsWith(".css"))).toBe(true);
    // Service Worker 自身と、Worker の出力は入らない
    expect(cached.urls).not.toContain("/sw.js");
    expect(cached.urls.some((url) => url.includes("wrangler"))).toBe(false);
  });

  test("オフラインで起動でき、クエリ付きのページ遷移にも殻を返す", async ({ page, context }) => {
    await page.goto("/");
    await expect(page.getByTestId("offline-ready")).toHaveText(offlineReady);

    await context.setOffline(true);
    await page.reload();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("YAPC::Tokyo 2026（ローカル）");
    await expect(page.getByTestId("offline-ready")).toHaveText(offlineReady);

    // Discord から /?login=... 付きで戻ったときも、殻を返す
    await page.goto("/?login=ok");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("YAPC::Tokyo 2026（ローカル）");
  });

  test("/api/ と /auth/ 以下の要求には、キャッシュから答えない", async ({ page, context }) => {
    await page.goto("/");
    await expect(page.getByTestId("offline-ready")).toHaveText(offlineReady);

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
