import { createHash } from "node:crypto";
import { isAbsolute, join, resolve } from "node:path";
import type { Plugin } from "vite";
import { ZXING_WASM_SHA256 } from "zxing-wasm/reader";
import { readConfigFileHead } from "../src/cli/config-file.ts";
import { PROJECT_ROOT } from "../src/cli/paths.ts";
import { describeRelease } from "../src/cli/release.ts";
import { configureJapaneseMessages } from "../src/core/messages.ts";
import { APP_VERSION_MAX_LENGTH } from "../src/core/sync.ts";
import { APP_ICONS, appIconPng } from "./app-icon.ts";

// 受付アプリの殻（アプリシェル）のビルド時の埋め込み（Design Doc 6.11）。
//
// - Service Worker（src/sw/sw.ts）を、受付アプリの出力に sw.js として加える
// - 事前にキャッシュするファイルの一覧と版を、受付アプリの出力から作って Service Worker に埋め込む。
//   手で書くと、上げ忘れたときに端末に古い版が残る（端末の挙動 10 章）
// - 一覧には、ファイルごとに、配信される中身のハッシュを添える。Service Worker は、取得した中身が
//   このビルドのものであることを、ハッシュで確かめてからキャッシュに入れる
// - このビルドのキャッシュ名を、受付アプリ（index.html の meta）にも埋め込む
// - 設定ファイルを読み、カンファレンスの表示名を受付アプリと manifest.webmanifest に埋め込む
// - リリース名を受付アプリに埋め込む
// - テスト用の入口（src/app/commands/test-hook.ts）を入れるかを、受付アプリに埋め込む
// - ホーム画面のアイコンを描いて、受付アプリの出力に加える（app-icon.ts）
// - QR の読み取り用の WASM（zxing-wasm の reader）が、出力にちょうど 1 つあり、評価した版の中身であることを確かめる
//
// vite-plugin-pwa を使わない理由は、フロントエンド 5.2 にある。

/** ビルドが読む設定ファイル。CLI の deploy が環境名から決めて渡す。なければローカルの開発の設定 */
const CONFIG_ENV = "CHECKIN_CONFIG";
/** リリース名。CLI の deploy が渡す。なければ git describe から求める */
const RELEASE_ENV = "CHECKIN_RELEASE";

/** テスト用の入口（window.__checkinTest）を入れるビルドにする。画面のテストのサーバ（test/e2e/setup/serve.ts）が渡す */
const TEST_HOOK_ENV = "CHECKIN_TEST_HOOK";

const SW_ENTRY = join(PROJECT_ROOT, "src/sw/sw.ts");
const SW_FILE = "sw.js";
const MANIFEST_FILE = "manifest.webmanifest";

/** Service Worker のキャッシュ名の接頭辞。src/sw/sw.ts の値と同じにする */
const CACHE_PREFIX = "app-shell-";

// 出力の中で、ビルドの終わりに値へ置き換える目印
const PRECACHE_PLACEHOLDER = "__PRECACHE_MANIFEST__";
const CACHE_NAME_PLACEHOLDER = "__APP_SHELL_CACHE__";

function configPath(): string {
  const path = process.env[CONFIG_ENV];
  if (path === undefined || path === "") return join(PROJECT_ROOT, "config", "local.toml");
  return isAbsolute(path) ? path : resolve(process.cwd(), path);
}

function releaseName(): string {
  const release = process.env[RELEASE_ENV] || describeRelease() || "unknown";
  // 同期の要求の appVersion の上限（Design Doc 4.5）
  return release.slice(0, APP_VERSION_MAX_LENGTH);
}

/**
 * QR の読み取り用の WASM（zxing-wasm 3.1.7 の reader）の SHA-256（zxing-wasm の導入指針）。
 * zxing-wasm の版を上げるときは、配布物を確かめ直してから、この値を書き換える
 */
const READER_WASM_SHA256 = "33c8c50be17d0bb05454b4fd3ffb5b5ab9a8e8d1c0ebeb21a1adf4a89c1a8b59";

const sha256 = (data: string | Uint8Array): string => createHash("sha256").update(data).digest("hex");

/** 置き換える目印が、ちょうど 1 か所にあることを確かめて置き換える */
function replaceOnce(text: string, placeholder: string, value: string, where: string): string {
  const parts = text.split(placeholder);
  if (parts.length !== 2) {
    throw new Error(`${where} に ${placeholder} が ${parts.length - 1} か所ある。ちょうど 1 か所でなければならない`);
  }
  return parts.join(value);
}

function webManifest(conferenceName: string): string {
  return JSON.stringify({
    name: conferenceName,
    short_name: conferenceName,
    lang: "ja",
    start_url: "/",
    scope: "/",
    display: "standalone",
    // Android のインストールしたアプリでは縦向きに固定する。Safari は対応していない（Design Doc 6.8）
    orientation: "portrait",
    // 起動のときの地の色と、ヘッダの面の色（画面設計書 2.10）
    background_color: "#f3f4f6",
    theme_color: "#ffffff",
    icons: APP_ICONS.filter((icon) => icon.fileName.startsWith("icon-")).map((icon) => ({
      src: `/${icon.fileName}`,
      sizes: `${icon.size}x${icon.size}`,
      type: "image/png",
      // 地を全面に塗ってあるので、切り抜かれる形（maskable）にも使える
      purpose: "any maskable",
    })),
  });
}

export function appShell(): Plugin {
  let conferenceName = "";
  let isBuild = false;

  return {
    name: "checkin:app-shell",
    enforce: "post",

    async config(_config, { command }) {
      isBuild = command === "build";
      // 設定ファイルの誤りを、読める文言で出す
      configureJapaneseMessages();
      const { conference } = await readConfigFileHead(configPath());
      conferenceName = conference.name;
      // テスト用の入口を入れるのは、ローカルの開発の設定でのビルドに限る。CLI の deploy は、呼んだシェルの
      // 環境変数をビルドに引き継ぐ。CHECKIN_TEST_HOOK が残っていても、カンファレンスの環境のビルドには入れない
      const testHook = conference.environment === "local" && (command === "serve" || process.env[TEST_HOOK_ENV] === "1");
      return {
        define: {
          __APP_RELEASE__: JSON.stringify(releaseName()),
          __CONFERENCE_NAME__: JSON.stringify(conferenceName),
          // テスト用の入口は、ローカルの開発サーバと、画面のテストのビルドにだけ入れる。本番のビルド（CLI の
          // deploy）では false に置き換わり、入口のコードごと出力から落ちる。QR の文字列の手入力は提供しない（FR-27）
          __TEST_HOOK__: JSON.stringify(testHook),
        },
      };
    },

    transformIndexHtml(_html, ctx) {
      return [
        { tag: "title", children: conferenceName, injectTo: "head" },
        { tag: "meta", attrs: { name: "apple-mobile-web-app-title", content: conferenceName }, injectTo: "head" },
        { tag: "link", attrs: { rel: "icon", type: "image/png", href: "/icon-192.png" }, injectTo: "head" },
        { tag: "link", attrs: { rel: "apple-touch-icon", href: "/apple-touch-icon.png" }, injectTo: "head" },
        {
          tag: "meta",
          // 開発サーバでは Service Worker を配らないので、キャッシュ名を持たない
          attrs: { name: "app-shell-cache", content: ctx.server ? "" : CACHE_NAME_PLACEHOLDER },
          injectTo: "head",
        },
      ];
    },

    // 開発サーバでは、マニフェストとアイコンだけを返す。Service Worker は配らない
    configureServer(server) {
      for (const icon of APP_ICONS) {
        server.middlewares.use(`/${icon.fileName}`, (_req, res) => {
          res.setHeader("Content-Type", "image/png");
          res.end(appIconPng(icon.size));
        });
      }
      server.middlewares.use(`/${MANIFEST_FILE}`, (_req, res) => {
        res.setHeader("Content-Type", "application/manifest+json");
        res.end(webManifest(conferenceName));
      });
    },

    buildStart() {
      // 受付アプリのビルドの出力にだけ加える。Worker の出力には加えない
      if (!isBuild || this.environment.name !== "client") return;
      this.emitFile({ type: "chunk", id: SW_ENTRY, fileName: SW_FILE });
      // generateBundle の中で加えたファイルは、その bundle に現れず、一覧から漏れる。ここで加える
      this.emitFile({ type: "asset", fileName: MANIFEST_FILE, source: webManifest(conferenceName) });
      for (const icon of APP_ICONS) {
        this.emitFile({ type: "asset", fileName: icon.fileName, source: appIconPng(icon.size) });
      }
    },

    generateBundle: {
      order: "post",
      handler(_options, bundle) {
        if (this.environment.name !== "client") return;

        const sw = bundle[SW_FILE];
        if (sw === undefined || sw.type !== "chunk") throw new Error(`${SW_FILE} が出力にない`);
        if (sw.imports.length > 0 || sw.dynamicImports.length > 0) {
          throw new Error(`${SW_FILE} がほかのファイルを読み込んでいる。Service Worker は 1 つのファイルにする`);
        }
        const html = bundle["index.html"];
        if (html === undefined || html.type !== "asset") throw new Error("index.html が出力にない");

        // 事前にキャッシュするのは、受付アプリの出力のうち、配信されるファイルのすべて（Service Worker 自身を除く）。
        // 「.」で始まる名前のファイル（Cloudflare の Vite プラグインが加える .assetsignore など）は配信されない。
        // 配信されないファイルが 1 つでも一覧にあると、事前のキャッシュが失敗して、Service Worker が有効にならない。
        // 殻の HTML は「/」として列挙する。ページ遷移で開くのも、ネットワークに届かないときに返すのも「/」である
        const served = Object.values(bundle)
          .filter((file) => file.fileName !== SW_FILE && !file.fileName.endsWith(".map"))
          .filter((file) => !file.fileName.split("/").some((segment) => segment.startsWith(".")))
          .sort((a, b) => (a.fileName < b.fileName ? -1 : 1));
        // 中身のハッシュ。この時点の中身から求めるので、中身を書き換えた後に呼び直すと値が変わる
        const digests = () =>
          served.map((file) => ({
            url: file.fileName === "index.html" ? "/" : `/${file.fileName}`,
            sha256: sha256(file.type === "chunk" ? file.code : file.source),
          }));

        // 版は中身から決める。index.html のようにファイル名にハッシュのないファイルが変わっても、版が変わる。
        // この時点の index.html は、キャッシュ名の代わりに目印を持つ。キャッシュ名は版から作るので、
        // キャッシュ名を埋め込んだ後の中身からは、版を求められない
        const version = sha256(JSON.stringify(digests())).slice(0, 16);

        html.source = replaceOnce(
          typeof html.source === "string" ? html.source : new TextDecoder().decode(html.source),
          CACHE_NAME_PLACEHOLDER,
          `${CACHE_PREFIX}${version}`,
          "index.html",
        );

        // Service Worker が照合するハッシュは、配信される中身（キャッシュ名を埋め込んだ後の index.html）から求める
        const files = digests();

        // QR の読み取り用の WASM。一覧から漏れると、オフラインでアプリを開けても QR を読み取れない。
        // full と writer の WASM は使わない。中身は、評価した版のものと、パッケージが公開する値の両方に合わせる
        const wasm = served.filter((file) => file.fileName.endsWith(".wasm"));
        const [reader] = wasm;
        if (wasm.length !== 1 || reader === undefined) {
          throw new Error(`出力の WASM が ${wasm.length} 個ある。QR の読み取り用の 1 個だけでなければならない`);
        }
        const readerDigest = files.find((file) => file.url === `/${reader.fileName}`)?.sha256;
        if (readerDigest !== READER_WASM_SHA256 || readerDigest !== ZXING_WASM_SHA256) {
          throw new Error(`${reader.fileName} の中身が、評価した版の zxing-wasm の reader のものと違う`);
        }
        for (const required of ["/", `/${MANIFEST_FILE}`]) {
          if (!files.some((file) => file.url === required)) {
            throw new Error(`事前にキャッシュする一覧に ${required} がない`);
          }
        }
        sw.code = replaceOnce(sw.code, PRECACHE_PLACEHOLDER, JSON.stringify({ version, files }), SW_FILE);
      },
    },
  };
}
