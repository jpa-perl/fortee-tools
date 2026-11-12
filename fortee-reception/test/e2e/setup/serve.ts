import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { join } from "node:path";
import { PROJECT_ROOT } from "../../../src/cli/paths.ts";
import { E2E_ENVIRONMENTS, E2E_SESSION_SECRET } from "./data.ts";
import { prepare } from "./prepare.ts";

// 画面のテスト（Playwright）のサーバ。playwright.config.ts の webServer が起動する。
//
//   node test/e2e/setup/serve.ts
//
// 1. 環境（data.ts の main と sync）ごとに、データを公開し直す（毎回、空から作る。prepare.ts）
// 2. ローカルの開発の設定（config/local.toml）でビルドする。テスト用の入口（window.__checkinTest）を入れる
// 3. ビルドした Worker と静的アセットを、環境ごとのポートで、その環境のデータに向けて配る
//
// vite.config.ts の vite preview は、ローカルの D1 と KV の保存先を替えられないので、ビルドの出力を
// wrangler dev で配る。セッションの秘密は、開発の .dev.vars の値ではなく、テスト用の値を渡す

const bin = (name: string): string => join(PROJECT_ROOT, "node_modules", ".bin", name);
const environments = Object.values(E2E_ENVIRONMENTS);

for (const environment of environments) await prepare(environment);
execFileSync(bin("vite"), ["build"], {
  cwd: PROJECT_ROOT,
  stdio: "inherit",
  // テスト用の入口は、このビルドと開発サーバにだけ入る（build/app-shell.ts）
  env: { ...process.env, CHECKIN_TEST_HOOK: "1" },
});

const servers: ChildProcess[] = [];
const stop = (): void => {
  for (const server of servers) server.kill("SIGTERM");
};
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, stop);

/** サーバが応えるまで待つ */
async function waitFor(port: number): Promise<void> {
  for (let i = 0; i < 600; i++) {
    const ok = await fetch(`http://localhost:${port}/`).then(
      (response) => response.ok,
      () => false,
    );
    if (ok) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`ポート ${port} のサーバが応えない`);
}

// 1 つずつ起動して、応えるのを待つ。Playwright は、最後に起動するサーバ（sync）が応えるのを待つので、
// その時点で、先に起動したサーバも応えている
for (const [i, environment] of environments.entries()) {
  const server = spawn(
    bin("wrangler"),
    [
      "dev",
      "--config",
      join(PROJECT_ROOT, "dist", "checkin_local", "wrangler.json"),
      "--persist-to",
      environment.target.persistTo ?? "",
      "--port",
      String(environment.port),
      // 2 つのサーバが、同じ検査用のポートを取り合わないようにする
      "--inspector-port",
      String(9339 + i),
      "--var",
      `SESSION_SECRET:${E2E_SESSION_SECRET}`,
      "--show-interactive-dev-session=false",
    ],
    { cwd: PROJECT_ROOT, stdio: "inherit" },
  );
  servers.push(server);
  // どちらかが終わったら、もう一方も止めて終わる
  server.on("exit", (code) => {
    stop();
    process.exit(code ?? 1);
  });
  await waitFor(environment.port);
}
