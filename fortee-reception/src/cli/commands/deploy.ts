import { execFileSync, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { CliError } from "../errors.ts";
import { assertReady } from "../marks.ts";
import { PROJECT_ROOT } from "../paths.ts";
import { describeRelease } from "../release.ts";
import type { Target } from "../target.ts";
import { deployWorker } from "../wrangler.ts";

// deploy（Design Doc 3.5、8.1）。受付アプリ、Service Worker、Worker を、その環境に向けてビルドし、デプロイする。
// 手で vite build と wrangler deploy を分けて実行しない。次のときは、ビルドの前に止まる。
//
// - 作業ツリーに未コミットの変更があるとき。見る範囲は、パッケージのディレクトリ以下に限る。
//   リポジトリのほかの道具の作業中の変更は、デプロイする内容を変えない。
//   --dangerously-allow-dirty を付けると、止まらずに、未コミットの変更を含めてデプロイする。
//   コミットする前の変更を実機で確かめるためのもので、リリース名の末尾に「-dirty」を付ける
// - 環境の印（Design Doc 3.6）が一致しないとき、CLI が持つマイグレーションが D1 に適用されていないとき

const require = createRequire(import.meta.url);

/** ビルドに渡す環境変数。build/app-shell.ts と、Cloudflare の Vite プラグインが読む */
export type BuildEnv = {
  /** wrangler.jsonc の env のうち、ビルドの対象にするもの（Cloudflare の Vite プラグイン） */
  CLOUDFLARE_ENV: string;
  /** ビルドが読む設定ファイル */
  CHECKIN_CONFIG: string;
  /** 受付アプリに埋め込むリリース名 */
  CHECKIN_RELEASE: string;
};

export type DeployOptions = {
  /** 未コミットの変更があっても、止まらずにデプロイする（--dangerously-allow-dirty） */
  allowDirty: boolean;
};

/** 未コミットの変更を含めてデプロイしたときに、リリース名の末尾に付ける印 */
export const DIRTY_SUFFIX = "-dirty";

export type DeployDeps = {
  log: (line: string) => void;
  /** パッケージのディレクトリ以下の、未コミットの変更（git status --porcelain の出力）。変更がなければ空文字 */
  uncommittedChanges: () => string;
  describeRelease: () => string | null;
  assertReady: (target: Target) => Promise<void>;
  build: (env: BuildEnv) => Promise<void>;
  deployWorker: (target: Target, release: string) => Promise<void>;
};

function uncommittedChanges(): string {
  try {
    // 「-- .」で、パッケージのディレクトリ以下に限る。追跡していないファイルも、ビルドに入りうるので含める
    return execFileSync("git", ["status", "--porcelain", "--", "."], { cwd: PROJECT_ROOT, encoding: "utf8" }).trimEnd();
  } catch {
    throw new CliError("git status を実行できません。未コミットの変更がないことを確かめられないので、デプロイしません");
  }
}

/** vite build を、端末につないで実行する */
function build(env: BuildEnv): Promise<void> {
  // vite の exports は bin/ を公開していないので、package.json の場所から辿る
  const viteBin = join(dirname(require.resolve("vite/package.json")), "bin", "vite.js");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [viteBin, "build"], {
      cwd: PROJECT_ROOT,
      env: { ...process.env, ...env },
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new CliError(`vite build が失敗しました（終了コード ${code}）。デプロイしていません`));
    });
  });
}

export const defaultDeployDeps = (log: (line: string) => void): DeployDeps => ({
  log,
  uncommittedChanges,
  describeRelease,
  assertReady,
  build,
  deployWorker,
});

export async function deploy(target: Target, options: DeployOptions, deps: DeployDeps): Promise<void> {
  if (target.local) {
    throw new CliError("ローカルの開発の環境（local）には、デプロイしません。開発サーバ（npm run dev）を使ってください");
  }

  const changes = deps.uncommittedChanges();
  if (changes !== "") {
    if (!options.allowDirty) {
      throw new CliError(`作業ツリーに未コミットの変更があります。コミットしてから、デプロイしてください\n${changes}`);
    }
    deps.log(`未コミットの変更を含めてデプロイします。デプロイする内容は、どのコミットとも一致しません\n${changes}`);
  }

  await deps.assertReady(target);

  const described = deps.describeRelease();
  if (described === null) throw new CliError("リリース名を git describe から求められません。デプロイしていません");
  // 未コミットの変更を含むときは、受付アプリの表示とデプロイの記録から、そのことが分かるようにする
  const release = changes === "" ? described : `${described}${DIRTY_SUFFIX}`;

  deps.log(`ビルドします（環境 ${target.env}、リリース ${release}）`);
  await deps.build({ CLOUDFLARE_ENV: target.env, CHECKIN_CONFIG: target.configPath, CHECKIN_RELEASE: release });

  deps.log("デプロイします");
  await deps.deployWorker(target, release);
  deps.log(`デプロイしました（環境 ${target.env}、リリース ${release}）`);
}
