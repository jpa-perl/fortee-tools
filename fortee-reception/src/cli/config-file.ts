import { readFile } from "node:fs/promises";
import { parse, TomlError } from "smol-toml";
import { type ConfigFileHead, configFileHeadSchema } from "../core/config.ts";
import { CliError } from "./errors.ts";

// 設定ファイル（TOML）の読み込み（Design Doc 4.2）。
// TOML を読むのは、このモジュールだけである。ほかは、検証済みの値を扱う。
// ビルド（build/）も、カンファレンスの表示名を埋め込むために、このモジュールを通して読む。
//
// ここで読むのは [conference] だけである。設定ファイル全体の検証（FR-4）と、
// 公開する JSON への変換は、validate と publish とともに足す。

export async function readConfigFileHead(path: string): Promise<ConfigFileHead> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    throw new CliError(`設定ファイル ${path} を読めません`);
  }

  let raw: unknown;
  try {
    raw = parse(text);
  } catch (error) {
    const detail = error instanceof TomlError ? `\n${error.message}` : "";
    throw new CliError(`設定ファイル ${path} を TOML として解析できません${detail}`);
  }

  const result = configFileHeadSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => `  ${issue.path.join(".")}: ${issue.message}`).join("\n");
    throw new CliError(`設定ファイル ${path} の [conference] に誤りがあります\n${issues}`);
  }
  return result.data;
}

/** 設定の conference.environment が --env と一致しなければ止める（Design Doc 3.6） */
export function assertEnvironmentMatches(config: ConfigFileHead, env: string, path: string): void {
  if (config.conference.environment !== env) {
    throw new CliError(
      `設定ファイル ${path} の conference.environment（"${config.conference.environment}"）が --env（"${env}"）と一致しません`,
    );
  }
}
