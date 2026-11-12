import { readFile } from "node:fs/promises";
import { parse, TomlDate, TomlError } from "smol-toml";
import { type ConfigFileHead, configFileHeadSchema } from "../core/config.ts";
import { type ConfigBody, type ConfigError, validateConfigFile } from "../core/config-file.ts";
import { CliError } from "./errors.ts";

// 設定ファイル（TOML）の読み込み（Design Doc 4.2）。
// TOML を読むのは、このモジュールだけである。ほかは、検証済みの値を扱う。
// ビルド（build/）も、カンファレンスの表示名を埋め込むために、このモジュールを通して読む。
//
// - readConfigFileHead: [conference] だけを読む。設定の中身を使わないコマンド（migrate、export など）とビルドが使う
// - loadConfigFile、readConfigFile: 設定ファイル全体を検証する（FR-4）。validate、import、preview、publish が使う

async function readToml(path: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    throw new CliError(`設定ファイル ${path} を読めません`);
  }
  try {
    return parse(text);
  } catch (error) {
    const detail = error instanceof TomlError ? `\n${error.message}` : "";
    throw new CliError(`設定ファイル ${path} を TOML として解析できません${detail}`);
  }
}

export async function readConfigFileHead(path: string): Promise<ConfigFileHead> {
  const raw = await readToml(path);
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

/**
 * TOML の日時の値を、文字列にする。期間のローカル日時（2026-11-27T17:30:00）は、smol-toml が TomlDate として読む。
 * 設定検証（core）は smol-toml に依存しないので、オフセットのない文字列（2026-11-27T17:30:00.000）に直して渡す。
 * オフセット付きの日時と、日付だけ、時刻だけの値も文字列になり、設定検証が形の誤りとして止める
 */
function stringifyDates(value: unknown): unknown {
  if (value instanceof TomlDate) return value.toISOString();
  if (Array.isArray(value)) return value.map(stringifyDates);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, stringifyDates(item)]));
  }
  return value;
}

export type LoadedConfig = { ok: true; config: ConfigBody } | { ok: false; errors: ConfigError[] };

/**
 * 設定ファイル全体を読んで検証する（FR-4、Design Doc 4.2 の検証の表）。conference.environment と --env の照合を含む。
 * 誤りは、止めずにすべて返す。ファイルを読めないときと、TOML として解析できないときは、CliError を投げる
 */
export async function loadConfigFile(path: string, env: string): Promise<LoadedConfig> {
  return validateConfigFile(stringifyDates(await readToml(path)), { env });
}

export function formatConfigErrors(errors: readonly ConfigError[]): string {
  return errors.map((error) => `  ${error.path === "" ? "（全体）" : error.path}: ${error.message}`).join("\n");
}

/** 設定ファイル全体を読んで検証し、誤りがあれば、すべて列挙して止まる */
export async function readConfigFile(path: string, env: string): Promise<ConfigBody> {
  const loaded = await loadConfigFile(path, env);
  if (!loaded.ok) {
    throw new CliError(
      `設定ファイル ${path} に誤りがあります（${loaded.errors.length} 件）\n${formatConfigErrors(loaded.errors)}`,
    );
  }
  return loaded.config;
}
