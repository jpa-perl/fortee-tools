import { expect, test } from "@playwright/test";
import { detectorState } from "./detector-check.ts";

// ブラウザの検出器（BarcodeDetector）が、確認用の QR の画像（services/detector-self-test.ts）を読めること
// （Design Doc 6.8）。受付アプリは、この画像を読めた検出器だけを使う。読めるはずの検出器が読めないと、
// 検出器が使える端末でも、常にキャンバスとデコーダで読み取ることになる。
// QR に対応した検出器があるブラウザ（macOS の Chromium など）でだけ確かめる。Linux の Chromium と WebKit には
// 検出器がないので、CI では常に飛ばされる。Android の実機では確かめていない

test("QR に対応した検出器は、確認用の画像を読める", async ({ page, baseURL }) => {
  // 検出器は、安全なコンテキストでだけ使える。受付アプリは開かず、同じオリジンの空のページで確かめる
  await page.route(`${baseURL}/detector-self-test`, (route) => route.fulfill({ contentType: "text/html", body: "<!doctype html><title>self-test</title>" }));
  await page.goto("/detector-self-test");
  const state = await detectorState(page);
  test.skip(state === "none" || state === "no qr_code", "このブラウザには、QR に対応した検出器がない");
  expect(state).toBe("qr_code");
});
