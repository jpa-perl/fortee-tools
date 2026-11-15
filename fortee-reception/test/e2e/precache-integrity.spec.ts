import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import { extname, join } from "node:path";
import { expect, test } from "@playwright/test";
import { E2E_HOST, e2eOrigin } from "./setup/data.ts";
import { readTlsOptions } from "./setup/tls.ts";

// 事前にキャッシュする中身の照合（Design Doc 6.11）。
// 取得の途中で配信が別の版に切り替わったときに、Service Worker が有効にならないことを確かめる。
// 配信を切り替えるために、本番のビルドの出力（dist/client）を、このテストが立てるサーバから配る。
// Worker は通らない。受付アプリの殻は、起動で /api/ を呼ばない


const CLIENT = join(process.cwd(), "dist/client");
const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".png": "image/png",
};

/** sw.js を配った後の要求（事前のキャッシュ）への応答を書き換える */
type Tamper = (path: string, body: Buffer) => Buffer;

type Site = { origin: string; tamperedServed: Promise<void>; close: () => Promise<void> };

async function serveClient(tamper: Tamper): Promise<Site> {
  let swServed = false;
  let resolveServed: () => void = () => {};
  const tamperedServed = new Promise<void>((resolve) => {
    resolveServed = resolve;
  });

  const server: Server = createServer(await readTlsOptions(), (req, res) => {
    const path = new URL(req.url ?? "/", `https://${E2E_HOST}`).pathname;
    const file = path === "/" ? "index.html" : path.slice(1);
    readFile(join(CLIENT, file)).then(
      (original) => {
        // Service Worker の cache: "reload" による取得だけを改変し、ページ自身の取得には触れない。
        const precache = swServed && req.headers["cache-control"] === "no-cache";
        const body = precache ? tamper(path, original) : original;
        res.writeHead(200, {
          "Content-Type": CONTENT_TYPES[extname(file)] ?? "application/octet-stream",
          "Cache-Control": "no-store",
        });
        res.end(body);
        if (path === "/sw.js") swServed = true;
        // 整合性の検証が失敗すると、残りの取得は中断される（macOS の WebKit など）。
        // 全ファイルではなく、改変した応答が実際に返ったことを待ってから、登録とキャッシュの消去を確かめる。
        if (!body.equals(original)) resolveServed();
      },
      () => {
        res.writeHead(404);
        res.end();
      },
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: e2eOrigin(port),
    tamperedServed,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

const state = () =>
  Promise.all([navigator.serviceWorker.getRegistrations(), caches.keys()]).then(([registrations, keys]) => ({
    registrations: registrations.length,
    caches: keys,
  }));

test("配信が切り替わらなければ、このサーバからでも事前のキャッシュが終わる", async ({ page }) => {
  // 下の 2 つのテストが、サーバの作りのせいで通っているのではないことを確かめる
  const site = await serveClient((_path, body) => body);
  try {
    await page.goto(site.origin);
    // 事前のキャッシュが終わると、Service Worker が有効になり、このビルドのキャッシュができる
    await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
    const { registrations, caches: names } = await page.evaluate(state);
    expect(registrations).toBe(1);
    expect(names).toEqual([await page.locator('meta[name="app-shell-cache"]').getAttribute("content")]);
  } finally {
    await site.close();
  }
});

test("取得の途中で別の版の HTML が返れば、Service Worker は有効にならない", async ({ page }) => {
  // この版の JavaScript と CSS の後に、別の版の「/」が返る。別の版の HTML は、別の JavaScript とキャッシュ名を指す
  const site = await serveClient((path, body) => {
    if (path !== "/") return body;
    const html = body.toString("utf8");
    return Buffer.from(
      html
        .replace(/(src="\/assets\/)[^"]+(\.js")/, "$1index-another-build$2")
        .replace(/(name="app-shell-cache" content=")[^"]+/, "$1app-shell-another-build"),
    );
  });
  try {
    await page.goto(site.origin);
    await site.tamperedServed;
    // インストールに失敗した Service Worker の登録は消え、キャッシュは作られない
    await expect.poll(() => page.evaluate(state)).toEqual({ registrations: 0, caches: [] });
  } finally {
    await site.close();
  }
});

test("取得した中身がこのビルドのものと違えば、Service Worker は有効にならない", async ({ page }) => {
  // 名前にハッシュのないファイルは、URL が同じまま中身が変わりうる
  const site = await serveClient((path, body) =>
    path === "/manifest.webmanifest" ? Buffer.from(body.toString("utf8").replace('"lang":"ja"', '"lang":"en"')) : body,
  );
  try {
    await page.goto(site.origin);
    await site.tamperedServed;
    await expect.poll(() => page.evaluate(state)).toEqual({ registrations: 0, caches: [] });
  } finally {
    await site.close();
  }
});
