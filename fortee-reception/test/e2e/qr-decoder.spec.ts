import { expect, type Page, test } from "@playwright/test";
import { login } from "./helpers.ts";
import { type QrMatrix, qrMatrix } from "./qr-matrix.ts";
import { qr } from "./setup/data.ts";

// QR のデコーダ（zxing-wasm）の、WASM の読み込みとデコード（Design Doc 6.8、zxing-wasm の導入指針）。
// ほかの spec の読み取りは、QR の文字列をテスト用の入口で渡すので、デコーダを通らない。ここでは、ページの
// キャンバスに描いた QR の画像を、カメラの読み取りと同じデコーダに渡す。
// WASM は、事前にキャッシュした同じオリジンのファイルだけを使う。オフラインでの最初の読み取りが成り立つことと、
// ライブラリの既定の取得先（CDN）へ要求が出ないことを確かめる。Chromium と WebKit の両方で確かめる

/** 灰色の地に QR を描いた画像を、デコーダに渡す。codes の x と y は、QR の左上の位置 */
async function decode(page: Page, size: { width: number; height: number }, codes: { matrix: QrMatrix; x: number; y: number }[]): Promise<string | null> {
  return page.evaluate(
    async ({ size, codes }) => {
      const canvas = document.createElement("canvas");
      canvas.width = size.width;
      canvas.height = size.height;
      const context = canvas.getContext("2d");
      if (context === null) throw new Error("文脈を取れない");
      context.fillStyle = "#999";
      context.fillRect(0, 0, size.width, size.height);
      const modulePx = 4;
      for (const { matrix, x, y } of codes) {
        const side = matrix.length * modulePx;
        context.fillStyle = "#fff";
        context.fillRect(x - modulePx * 4, y - modulePx * 4, side + modulePx * 8, side + modulePx * 8);
        context.fillStyle = "#000";
        matrix.forEach((cells, row) =>
          cells.forEach((dark, col) => {
            if (dark) context.fillRect(x + col * modulePx, y + row * modulePx, modulePx, modulePx);
          }),
        );
      }
      const hook = window.__checkinTest;
      if (hook === undefined) throw new Error("テスト用の入口がない");
      return hook.decode(context.getImageData(0, 0, size.width, size.height));
    },
    { size, codes },
  );
}

test("オフラインでの最初の読み取りで、同じオリジンの WASM だけを使ってデコードする", async ({ page, baseURL }) => {
  const requested: string[] = [];
  page.context().on("request", (request) => requested.push(request.url()));

  // オンラインで準備する。Service Worker が、WASM を含む殻を事前にキャッシュする
  await login(page, baseURL, { offline: false });
  await page.getByRole("button", { name: "メニュー" }).click();
  await expect(page.locator("dt", { hasText: "アプリ" }).locator("xpath=following-sibling::dd")).toContainText("オフラインで起動できます");
  await page.getByRole("button", { name: "戻る" }).click();

  // オフラインにして読み込み直す。この時点で、WASM はまだ初期化されていない
  await page.context().setOffline(true);
  await page.reload();

  const main = qr("main", "A-5");
  const other = qr("main", "A-12");
  const side = qrMatrix(main).length * 4;

  // 最初の読み取り
  expect(await decode(page, { width: 640, height: 480 }, [{ matrix: qrMatrix(main), x: 240, y: 150 }])).toBe(main);
  // QR がなければ null
  expect(await decode(page, { width: 640, height: 480 }, [])).toBeNull();
  // 複数あれば、中央に最も近いもの
  expect(
    await decode(page, { width: 640, height: 480 }, [
      { matrix: qrMatrix(other), x: 30, y: 30 },
      { matrix: qrMatrix(main), x: 320 - side / 2 + 20, y: 240 - side / 2 },
    ]),
  ).toBe(main);
  // 長辺が上限を超える画像は、渡さない
  expect(await decode(page, { width: 800, height: 480 }, [{ matrix: qrMatrix(main), x: 240, y: 150 }])).toBeNull();

  // WASM は、同じオリジンから取得する。別のオリジンへの要求は、1 つもない
  const origin = new URL(baseURL ?? "").origin;
  // （ブラウザによって、Service Worker の事前のキャッシュの取得も数える）
  expect(requested.some((url) => new URL(url).pathname.endsWith(".wasm"))).toBe(true);
  expect(requested.filter((url) => new URL(url).origin !== origin)).toEqual([]);
});

test("WASM を取得できなくても、CDN へは取りに行かず、取得できるようになれば読み取れる", async ({ page, baseURL }) => {
  const requested: string[] = [];
  page.context().on("request", (request) => requested.push(request.url()));

  await login(page, baseURL, { offline: false });
  await page.getByRole("button", { name: "メニュー" }).click();
  await expect(page.locator("dt", { hasText: "アプリ" }).locator("xpath=following-sibling::dd")).toContainText("オフラインで起動できます");
  await page.getByRole("button", { name: "戻る" }).click();
  await page.context().setOffline(true);
  await page.reload();

  // 事前のキャッシュから、WASM だけを消す。オフラインなので、デコーダは WASM を取得できない
  const deleted = await page.evaluate(async () => {
    const name = document.querySelector<HTMLMetaElement>('meta[name="app-shell-cache"]')?.content ?? "";
    const cache = await caches.open(name);
    const wasm = (await cache.keys()).filter((request) => new URL(request.url).pathname.endsWith(".wasm"));
    await Promise.all(wasm.map((request) => cache.delete(request)));
    return wasm.length;
  });
  expect(deleted).toBe(1);

  const main = qr("main", "A-5");
  const image = [{ matrix: qrMatrix(main), x: 240, y: 150 }];
  // 読み取れなかったものとして返る。例外にはならない
  expect(await decode(page, { width: 640, height: 480 }, image)).toBeNull();
  expect(await decode(page, { width: 640, height: 480 }, image)).toBeNull();
  const origin = new URL(baseURL ?? "").origin;
  expect(requested.filter((url) => new URL(url).origin !== origin)).toEqual([]);

  // 取得できるようになれば、初期化し直して読み取る。失敗の直後の 1 秒は試さない
  await page.context().setOffline(false);
  await expect.poll(() => decode(page, { width: 640, height: 480 }, image), { timeout: 10_000 }).toBe(main);
  expect(requested.filter((url) => new URL(url).origin !== origin)).toEqual([]);
});
