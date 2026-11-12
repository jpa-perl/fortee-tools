import { createHash } from "node:crypto";
import { isAbsolute, join, resolve } from "node:path";
import type { Plugin } from "vite";
import { readConfigFileHead } from "../src/cli/config-file.ts";
import { PROJECT_ROOT } from "../src/cli/paths.ts";
import { describeRelease } from "../src/cli/release.ts";
import { configureJapaneseMessages } from "../src/core/messages.ts";
import { APP_VERSION_MAX_LENGTH } from "../src/core/sync.ts";

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
//
// vite-plugin-pwa を使わない理由は、フロントエンド 5.2 にある。

/** ビルドが読む設定ファイル。CLI の deploy が環境名から決めて渡す。なければローカルの開発の設定 */
const CONFIG_ENV = "CHECKIN_CONFIG";
/** リリース名。CLI の deploy が渡す。なければ git describe から求める */
const RELEASE_ENV = "CHECKIN_RELEASE";

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
      conferenceName = (await readConfigFileHead(configPath())).conference.name;
      return {
        define: {
          __APP_RELEASE__: JSON.stringify(releaseName()),
          __CONFERENCE_NAME__: JSON.stringify(conferenceName),
        },
      };
    },

    transformIndexHtml(_html, ctx) {
      return [
        { tag: "title", children: conferenceName, injectTo: "head" },
        { tag: "meta", attrs: { name: "apple-mobile-web-app-title", content: conferenceName }, injectTo: "head" },
        {
          tag: "meta",
          // 開発サーバでは Service Worker を配らないので、キャッシュ名を持たない
          attrs: { name: "app-shell-cache", content: ctx.server ? "" : CACHE_NAME_PLACEHOLDER },
          injectTo: "head",
        },
      ];
    },

    // 開発サーバでは、マニフェストだけを返す。Service Worker は配らない
    configureServer(server) {
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
