import { expect, type Page, test } from "@playwright/test";
import { login, settle } from "./helpers.ts";

// フォーカスの輪郭（画面設計書 2.11、Design Doc 6.12）。
// 外付けのキーボードで操作したときは、フォーカスのある要素を、青で太さ 3px の輪郭で示す。
// タップで操作したときには出さない。ただし、入力欄には、タップで入力を始めたときにも出す。
// :focus-visible がいつ当たるかはブラウザに任されているので、対象のブラウザの振る舞いを、ここで確かめる

/** 輪郭が出ている要素の数 */
const outlined = (page: Page): Promise<number> =>
  page.evaluate(
    () =>
      Array.from(document.querySelectorAll<HTMLElement>("body *")).filter((element) => {
        const style = getComputedStyle(element);
        return style.outlineStyle !== "none" && Number.parseFloat(style.outlineWidth) > 0;
      }).length,
  );

test("ボタンをタップしても、輪郭は出ない", async ({ page, baseURL }) => {
  await login(page, baseURL);
  await page.getByRole("button", { name: "メニュー" }).click();
  await page.getByRole("button", { name: "音を試す" }).click();
  await page.getByRole("switch", { name: "音" }).click();
  expect(await outlined(page)).toBe(0);
});

test("入力欄をタップすると、輪郭が出る", async ({ page, baseURL }) => {
  await login(page, baseURL);
  await page.getByRole("button", { name: "履歴をすべて見る" }).click();
  expect(await outlined(page)).toBe(0);
  await page.getByRole("textbox", { name: "履歴を検索" }).click();
  // 輪郭は、入力欄を囲む枠の外に出す
  const field = page.locator(".field");
  await expect(field).toHaveCSS("outline-style", "solid");
  await expect(field).toHaveCSS("outline-width", "3px");
  await expect(field).toHaveCSS("outline-offset", "2px");
  await expect(field).toHaveCSS("outline-color", "rgb(31, 79, 160)");
  expect(await outlined(page)).toBe(1);
});

test("タップで開いたシートとダイアログの中に、輪郭は出ない", async ({ page, baseURL }) => {
  await login(page, baseURL);

  // シート。開いたときのフォーカスは、中のボタンではなく、シート自身に置く
  await page.getByRole("button", { name: "受付を切り替える" }).click();
  await settle(page);
  expect(await page.evaluate(() => document.activeElement?.tagName)).toBe("DIALOG");
  expect(await outlined(page)).toBe(0);
  // 中身を確認に切り替えても、出ない
  await page.getByRole("dialog").getByRole("button", { name: /前夜祭受付/ }).click();
  await settle(page);
  expect(await outlined(page)).toBe(0);
  await page.getByRole("dialog").getByRole("button", { name: "やめる" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "閉じる" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);

  // ダイアログ
  await page.getByRole("button", { name: "メニュー" }).click();
  await page.getByRole("button", { name: "ログアウト" }).click();
  await settle(page);
  expect(await page.evaluate(() => document.activeElement?.tagName)).toBe("DIALOG");
  expect(await outlined(page)).toBe(0);
});

test("キーボードで操作すると、フォーカスのある要素に輪郭が出る", async ({ page, baseURL, browserName }) => {
  await login(page, baseURL);
  // Safari は、既定では Tab でボタンに移らない（Option を足す）
  const tab = browserName === "webkit" ? "Alt+Tab" : "Tab";

  await page.keyboard.press(tab);
  const focused = page.locator(":focus");
  await expect(focused).toHaveCount(1);
  expect(await focused.evaluate((element) => element.tagName)).toBe("BUTTON");
  await expect(focused).toHaveCSS("outline-style", "solid");
  await expect(focused).toHaveCSS("outline-width", "3px");
  await expect(focused).toHaveCSS("outline-offset", "2px");
  await expect(focused).toHaveCSS("outline-color", "rgb(31, 79, 160)");
  expect(await outlined(page)).toBe(1);

  // シートの中でも、Tab で中の要素に移ると出る。フォーカスは、シートの中に閉じ込められる
  await page.getByRole("button", { name: "受付を切り替える" }).click();
  await settle(page);
  expect(await outlined(page)).toBe(0);
  await page.keyboard.press(tab);
  await expect(page.getByRole("dialog").locator(":focus")).toHaveCSS("outline-style", "solid");
  expect(await outlined(page)).toBe(1);
});
