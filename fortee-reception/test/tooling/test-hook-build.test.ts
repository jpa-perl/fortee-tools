import { execFileSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// テスト用の入口（window.__checkinTest。src/app/commands/test-hook.ts）が、本番のビルドの出力に入らないこと。
// QR の文字列の手入力は提供しない（FR-27）。入口は、開発サーバと、画面のテストのビルド
// （test/e2e/setup/serve.ts が CHECKIN_TEST_HOOK=1 を渡す）にだけ入る。
// CLI の deploy と同じく vite build を実行して、出力のファイルを調べる。出力先は一時ディレクトリにする

const ROOT = join(import.meta.dirname, "..", "..");
const VITE = join(ROOT, "node_modules", ".bin", "vite");
/** Cloudflare の Vite プラグインが、ビルドのたびに書く、wrangler の設定の向き先。ビルドの後に戻す */
const REDIRECT = join(ROOT, ".wrangler", "deploy", "config.json");
const HOOK = "__checkinTest";

let dir = "";
let redirect: string | null = null;

/** ビルドして、出力のうち、テスト用の入口の名前を含むファイルを返す */
async function buildAndFind(name: string, env: Record<string, string | undefined>): Promise<string[]> {
  const out = join(dir, name);
  execFileSync(VITE, ["build", "--outDir", out, "--logLevel", "error"], { cwd: ROOT, env: { ...process.env, ...env }, stdio: "pipe" });
  const found: string[] = [];
  for (const entry of await readdir(out, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    if ((await readFile(path)).includes(HOOK)) found.push(path.slice(out.length + 1));
  }
  return found;
}

describe("テスト用の入口", () => {
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "checkin-hook-build-"));
    redirect = await readFile(REDIRECT, "utf8").catch(() => null);
  });

  afterAll(async () => {
    if (redirect === null) await rm(REDIRECT, { force: true });
    else await writeFile(REDIRECT, redirect);
    await rm(dir, { recursive: true, force: true });
  });

  it("本番のビルドの出力には、入らない", async () => {
    expect(await buildAndFind("production", { CHECKIN_TEST_HOOK: undefined })).toEqual([]);
  }, 120_000);

  it("カンファレンスの環境の設定でのビルドには、環境変数が残っていても、入らない", async () => {
    // CLI の deploy は、呼んだシェルの環境変数をビルドに引き継ぐ
    const config = join(dir, "conference.toml");
    const local = await readFile(join(ROOT, "config", "local.toml"), "utf8");
    await writeFile(config, local.replace('environment = "local"', 'environment = "yapc-tokyo-2026"'));
    expect(await buildAndFind("conference", { CHECKIN_TEST_HOOK: "1", CHECKIN_CONFIG: config })).toEqual([]);
  }, 120_000);

  it("画面のテストのビルドの出力には、受付アプリの JavaScript にだけ入る", async () => {
    // 上のテストが、探し方の誤りで通っているのではないことも確かめる
    const found = await buildAndFind("e2e", { CHECKIN_TEST_HOOK: "1" });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(/^client\/assets\/.+\.js$/);
  }, 120_000);
});
