import { isAbsolute, join, resolve } from "node:path";
import { CliError } from "./errors.ts";
import { PROJECT_ROOT } from "./paths.ts";

// 環境（Design Doc 3.6）。--env の 1 つの値から、wrangler の env、設定ファイル、作業ディレクトリを決める。
// 対象の指定が複数の場所に分かれ、一部だけを取り違えることを防ぐ。

/** ローカルの開発の環境名。どのカンファレンスの環境とも接続しない */
export const LOCAL_ENV = "local";

// Worker の名前は checkin-<環境名> で、Worker の名前の上限は 63 文字
const ENV_NAME = /^[a-z0-9](?:[a-z0-9-]{0,53}[a-z0-9])?$/;

export type Target = {
  /** 環境名。カンファレンスの fortee のスラッグか、local */
  env: string;
  /** ローカルの開発のデータ（.wrangler/state）を対象にするか */
  local: boolean;
  /** 設定ファイル（TOML）のパス */
  configPath: string;
  /** 取り込みの出力などを置く作業ディレクトリ */
  workDir: string;
  /** ローカルのデータの保存先。テストが一時ディレクトリに向けるためのもので、ふだんは指定しない */
  persistTo?: string;
  /**
   * wrangler の設定ファイルと、マイグレーションのディレクトリ。テストが、マイグレーションを足した
   * 写しに向けるためのもので、ふだんは指定しない（パッケージの wrangler.jsonc と migrations/ を使う）。
   * 指定するときは、設定ファイルの migrations_dir と同じディレクトリを migrationsDir に渡す
   */
  wranglerConfig?: string;
  migrationsDir?: string;
};

export function resolveTarget(options: { env: string | undefined; config?: string | undefined; persistTo?: string }): Target {
  const { env } = options;
  if (env === undefined || env === "") {
    throw new CliError("--env <環境名> を指定してください。既定値はありません（ローカルの開発は --env local）");
  }
  if (!ENV_NAME.test(env)) {
    throw new CliError(`環境名 "${env}" は使えません。英小文字、数字、「-」の 55 文字までで指定してください`);
  }

  const configPath =
    options.config === undefined
      ? join(PROJECT_ROOT, "config", `${env}.toml`)
      : isAbsolute(options.config)
        ? options.config
        : resolve(process.cwd(), options.config);

  return {
    env,
    local: env === LOCAL_ENV,
    configPath,
    workDir: join(PROJECT_ROOT, ".work", env),
    ...(options.persistTo === undefined ? {} : { persistTo: options.persistTo }),
  };
}
