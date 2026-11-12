import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join } from "node:path";
import { E2E_ENVIRONMENTS } from "./data.ts";

// Service Worker の更新を確かめるためのサーバ（Design Doc 6.11、11 章）。
//
// 本番のビルドの出力（dist/client）を、テストごとに立てるサーバから配り、配る版を途中で切り替える。
// 版 2 は、ビルドをやり直さずに、版 1 の出力から作る。殻の HTML に印を足し、キャッシュ名を替え、
// Service Worker に埋め込まれた版と HTML のハッシュを、それに合わせて直す。ビルドが作る版と同じく、
// 中身が違えば、Service Worker のファイルも、キャッシュ名も違う。
// /api/ と /auth/ 以下は、画面のテストのサーバ（main）に取り次ぐ。オリジンが違うので、IndexedDB と
// ロックは、ほかの spec と分かれる

const CLIENT = join(process.cwd(), "dist/client");
const UPSTREAM = { host: "localhost", port: E2E_ENVIRONMENTS.main.port };
const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".png": "image/png",
};

/** 殻の HTML に足す印。ページが、どの版の殻で動いているかを見分ける */
export const SHELL_VERSION_META = "e2e-shell-version";

const sha256 = (data: Buffer): string => createHash("sha256").update(data).digest("hex");

function replaceOnce(text: string, from: string, to: string): string {
  const parts = text.split(from);
  if (parts.length !== 2) throw new Error(`${from} が ${parts.length - 1} か所ある。ちょうど 1 か所でなければならない`);
  return parts.join(to);
}

export type ShellSite = {
  origin: string;
  /** 配る版。1 はビルドの出力そのまま。2 は、そこから作った別の版 */
  version: 1 | 2;
  /**
   * 真の間、Service Worker の事前のキャッシュの、殻の JavaScript の取得を 500 にする。
   * ページ自身が読み込む JavaScript は通す（通さないと、受付アプリが起動しない）
   */
  failPrecache: boolean;
  /** 真の間、同期の要求を 503 にする。データの取得を失敗させる */
  failSync: boolean;
  /** 真の間、同期の要求を 401 にする。ログインの期限が切れた状態にする */
  unauthorizedSync: boolean;
  /** 版ごとのキャッシュ名 */
  cacheName(version: 1 | 2): string;
  close(): Promise<void>;
};

export async function serveShell(): Promise<ShellSite> {
  const html1 = await readFile(join(CLIENT, "index.html"), "utf8");
  const sw1 = await readFile(join(CLIENT, "sw.js"), "utf8");
  const version1 = /"version":"([0-9a-f]+)"/.exec(sw1)?.[1];
  if (version1 === undefined) throw new Error("sw.js に、埋め込まれた版がない");
  const version2 = `e2e${version1.slice(3)}`;
  const html2 = replaceOnce(
    replaceOnce(html1, `app-shell-${version1}`, `app-shell-${version2}`),
    "</head>",
    `<meta name="${SHELL_VERSION_META}" content="2"></head>`,
  );
  const sw2 = replaceOnce(
    replaceOnce(sw1, `"version":"${version1}"`, `"version":"${version2}"`),
    `{"url":"/","sha256":"${sha256(Buffer.from(html1))}"}`,
    `{"url":"/","sha256":"${sha256(Buffer.from(html2))}"}`,
  );

  const site: ShellSite = {
    origin: "",
    version: 1,
    failPrecache: false,
    failSync: false,
    unauthorizedSync: false,
    cacheName: (version) => `app-shell-${version === 1 ? version1 : version2}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };

  const server: Server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;

    if (path.startsWith("/api/") || path.startsWith("/auth/")) {
      if ((site.failSync || site.unauthorizedSync) && path === "/api/sync") {
        res.writeHead(site.unauthorizedSync ? 401 : 503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: site.unauthorizedSync ? "unauthorized" : "unavailable" }));
        return;
      }
      // Worker は、同じオリジンからの要求だけを受け付ける。取り次ぎ先のオリジンに書き換える
      const upstreamOrigin = `http://${UPSTREAM.host}:${UPSTREAM.port}`;
      const headers = { ...req.headers, host: `${UPSTREAM.host}:${UPSTREAM.port}` };
      if (headers.origin !== undefined) headers.origin = upstreamOrigin;
      const upstream = httpRequest({ ...UPSTREAM, path: req.url, method: req.method, headers }, (response) => {
        res.writeHead(response.statusCode ?? 502, response.headers);
        response.pipe(res);
      });
      upstream.on("error", () => {
        res.writeHead(502);
        res.end();
      });
      req.pipe(upstream);
      return;
    }

    // 事前のキャッシュは、HTTP キャッシュを通さない取得（cache: "reload"）で、Cache-Control: no-cache が付く
    const precache = req.headers["cache-control"] === "no-cache";
    if (site.failPrecache && precache && path.endsWith(".js") && path !== "/sw.js") {
      res.writeHead(500);
      res.end();
      return;
    }
    const file = path === "/" ? "index.html" : path.slice(1);
    const headers = { "Content-Type": CONTENT_TYPES[extname(file)] ?? "application/octet-stream", "Cache-Control": "no-store" };
    if (site.version === 2 && (file === "index.html" || file === "sw.js")) {
      res.writeHead(200, headers);
      res.end(file === "index.html" ? html2 : sw2);
      return;
    }
    readFile(join(CLIENT, file)).then(
      (body) => {
        res.writeHead(200, headers);
        res.end(body);
      },
      () => {
        res.writeHead(404);
        res.end();
      },
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  site.origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return site;
}
