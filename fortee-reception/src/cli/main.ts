import { resolve } from "node:path";
import { parseArgs } from "node:util";
import type { ConfigBody } from "../core/config-file.ts";
import { configureJapaneseMessages } from "../core/messages.ts";
import { bumpGeneration } from "./commands/bump-generation.ts";
import { defaultDeployDeps, deploy } from "./commands/deploy.ts";
import { exportRecords } from "./commands/export.ts";
import { importZip } from "./commands/import.ts";
import { migrate } from "./commands/migrate.ts";
import { preview } from "./commands/preview.ts";
import { publish } from "./commands/publish.ts";
import { restoreRecords } from "./commands/restore-records.ts";
import { validate } from "./commands/validate.ts";
import { assertEnvironmentMatches, readConfigFile, readConfigFileHead } from "./config-file.ts";
import { CliError } from "./errors.ts";
import { assertReady } from "./marks.ts";
import { describeRelease } from "./release.ts";
import { resolveTarget, type Target } from "./target.ts";

// 管理 CLI の入口（Design Doc 8.1）。1 つの実行ファイルにサブコマンドを持たせる。
// すべてのコマンドは --env <環境名> で対象の環境を受け取り、既定値を持たない。
// 参加者の情報をログに出さない（Design Doc 9.3）。

/** すべてのコマンドのオプション。どのコマンドがどれを受け取るかは、COMMANDS で決める */
const OPTIONS = {
  env: { type: "string" },
  config: { type: "string" },
  help: { type: "boolean", short: "h" },
  event: { type: "string" },
  zip: { type: "string" },
  ticket: { type: "string" },
  reception: { type: "string" },
  done: { type: "string", multiple: true },
  out: { type: "string" },
  chunk: { type: "string" },
  "drift-threshold": { type: "string" },
  from: { type: "string" },
  "dangerously-allow-dirty": { type: "boolean" },
} as const;

type OptionName = keyof typeof OPTIONS;
type Values = Partial<Record<OptionName, string | boolean | (string | boolean)[]>>;

/** どのコマンドも受け取るオプション */
const GLOBAL_OPTIONS: readonly OptionName[] = ["env", "config", "help"];

type Context = {
  target: Target;
  values: Values;
  /** 検証済みの設定。config が "full" のコマンドだけが持つ */
  config: ConfigBody | undefined;
};

type Command = {
  summary: string;
  /** 使い方に出す、このコマンドの引数 */
  usage?: string;
  /** --env、--config、--help のほかに、このコマンドが受け取るオプションの名前 */
  options?: readonly OptionName[];
  /**
   * 実行の前に、設定ファイルをどこまで読むか。どれも、conference.environment が --env と一致しなければ止まる。
   * - head: [conference] だけを読む
   * - full: 設定ファイル全体を検証し（FR-4）、誤りがあれば、すべて列挙して止まる
   * - self: コマンドが自分で読む（validate）
   */
  config: "head" | "full" | "self";
  /** D1 と KV を読み書きする前に、環境の印とマイグレーションを照合するか（Design Doc 8.1） */
  needsReady: boolean;
  run: (context: Context) => Promise<void>;
};

const log = (line: string): void => {
  console.log(line);
};
const warn = (line: string): void => {
  console.error(line);
};
const now = (): number => Date.now();

/** 必須の、値を取るオプション */
function required(values: Values, name: OptionName): string {
  const value = values[name];
  if (typeof value !== "string" || value === "") throw new CliError(`--${name} <値> を指定してください`);
  return value;
}

function optional(values: Values, name: OptionName): string | undefined {
  const value = values[name];
  return typeof value === "string" ? value : undefined;
}

/** 正の整数を取るオプション。省略なら undefined */
function positiveInteger(values: Values, name: OptionName): number | undefined {
  const value = optional(values, name);
  if (value === undefined) return undefined;
  if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new CliError(`--${name} には、1 以上の整数を指定してください（"${value}"）`);
  }
  return Number(value);
}

/** パスを取るオプション。相対パスは、いまのディレクトリから解決する */
const pathOf = (value: string): string => resolve(process.cwd(), value);

const configOf = (context: Context): ConfigBody => {
  if (context.config === undefined) throw new Error("設定を読んでいないコマンドが、設定を使おうとした");
  return context.config;
};

const COMMANDS: Record<string, Command> = {
  validate: {
    summary: "設定ファイルを検証する",
    config: "self",
    needsReady: false,
    run: ({ target }) => validate(target, log),
  },
  import: {
    summary: "fortee の ZIP から、イベントのスナップショットを作る",
    usage: "--event <key か id> --zip <ZIP>",
    options: ["event", "zip"],
    config: "full",
    needsReady: false,
    run: (context) =>
      importZip(
        context.target,
        configOf(context),
        { event: required(context.values, "event"), zip: pathOf(required(context.values, "zip")) },
        { now, log, warn },
      ),
  },
  preview: {
    summary: "参考情報テンプレートを描画する",
    usage: "--event <key か id> --ticket <チケット番号> [--reception <受付の id>] [--done <イベント>:<チケット番号>]...",
    options: ["event", "ticket", "reception", "done"],
    config: "full",
    needsReady: false,
    run: (context) => {
      const done = context.values.done;
      return preview(
        context.target,
        configOf(context),
        {
          event: required(context.values, "event"),
          ticket: required(context.values, "ticket"),
          reception: optional(context.values, "reception"),
          done: Array.isArray(done) ? done.filter((value): value is string => typeof value === "string") : [],
        },
        { now, out: (text) => process.stdout.write(text.endsWith("\n") ? text : `${text}\n`), warn },
      );
    },
  },
  publish: {
    summary: "スナップショットと設定を公開する",
    config: "full",
    needsReady: true,
    run: (context) => publish(context.target, configOf(context), { now, log, warn }),
  },
  export: {
    summary: "記録から、書き出しの各ファイルを作る",
    usage: "--out <まだないディレクトリ> [--chunk <行数>] [--drift-threshold <分>]",
    options: ["out", "chunk", "drift-threshold"],
    config: "head",
    needsReady: true,
    run: ({ target, values }) =>
      exportRecords(
        target,
        {
          out: pathOf(required(values, "out")),
          chunk: positiveInteger(values, "chunk"),
          driftThresholdMinutes: positiveInteger(values, "drift-threshold"),
        },
        { now, release: describeRelease(), log },
      ),
  },
  "restore-records": {
    summary: "書き出しの記録のダンプを D1 に戻す",
    usage: "--from <records.json>",
    options: ["from"],
    config: "head",
    needsReady: true,
    run: ({ target, values }) => restoreRecords(target, { from: pathOf(required(values, "from")) }, log),
  },
  "bump-generation": {
    summary: "世代を書き換える",
    config: "head",
    needsReady: true,
    run: ({ target }) => bumpGeneration(target, log),
  },
  // migrate は印を書く側で、これからマイグレーションを適用するので、ある印の照合だけを自分で行う
  migrate: {
    summary: "D1 にマイグレーションを適用し、環境の印を書く",
    config: "head",
    needsReady: false,
    run: ({ target }) => migrate(target, log),
  },
  // deploy は、未コミットの変更を確かめてから、環境の印とマイグレーションを自分で照合する
  deploy: {
    summary: "ビルドしてデプロイする",
    usage: "[--dangerously-allow-dirty]",
    options: ["dangerously-allow-dirty"],
    config: "head",
    needsReady: false,
    run: ({ target, values }) =>
      deploy(target, { allowDirty: values["dangerously-allow-dirty"] === true }, defaultDeployDeps(log)),
  },
};

function usage(): string {
  const width = Math.max(...Object.keys(COMMANDS).map((name) => name.length));
  const lines = Object.entries(COMMANDS).flatMap(([name, command]) => [
    `  ${name.padEnd(width)}  ${command.summary}`,
    ...(command.usage === undefined ? [] : [`  ${"".padEnd(width)}    ${command.usage}`]),
  ]);
  return [
    "使い方: npm run admin -- <コマンド> --env <環境名> [--config <TOML>] [コマンドの引数]",
    "",
    "コマンド:",
    ...lines,
    "",
    "--env は必須で、既定値はありません。ローカルの開発は --env local です。",
    "設定ファイルは config/<環境名>.toml を読みます。--config で替えられます。",
  ].join("\n");
}

async function main(argv: string[]): Promise<void> {
  // 設定ファイルの誤りを、読める文言で出す
  configureJapaneseMessages();

  const { values, positionals, tokens } = parseArgs({
    args: argv,
    allowPositionals: true,
    // 知らないオプションと、そのコマンドが受け取らないオプションは、コマンドが分かってから下で確かめる
    strict: false,
    tokens: true,
    options: OPTIONS,
  });

  // 値を取るオプションに値がないことを、省略と区別する。区別しないと、値のない --config が
  // 指定のないものとして扱われ、既定の設定ファイルで先へ進む
  for (const token of tokens) {
    if (token.kind !== "option" || !(token.name in OPTIONS)) continue;
    if (OPTIONS[token.name as OptionName].type !== "string") continue;
    // 値が次の引数として渡され、「-」で始まるときは、値を書き忘れて次のオプションを取り込んでいる
    const swallowedOption = token.inlineValue === false && token.value?.startsWith("-") === true;
    if (typeof token.value !== "string" || swallowedOption) {
      throw new CliError(`${token.rawName} には値が要ります（例: ${token.rawName} <値>、${token.rawName}=<値>）`);
    }
  }

  const name = positionals[0];
  if (values.help === true || name === undefined) {
    log(usage());
    if (name === undefined && values.help !== true) process.exitCode = 1;
    return;
  }
  const command = COMMANDS[name];
  if (command === undefined) throw new CliError(`知らないコマンドです: ${name}\n\n${usage()}`);

  // 知らないオプション、そのコマンドが受け取らないオプション、余分な引数を誤りにする。黙って無視すると、
  // --config を打ち間違えたときに、既定の設定ファイルで先へ進んでしまう
  const known = new Set<string>([...GLOBAL_OPTIONS, ...(command.options ?? [])]);
  const rejected = [...new Set(tokens.flatMap((token) => (token.kind === "option" && !known.has(token.name) ? [token] : [])))];
  const unknown = rejected.filter((token) => !(token.name in OPTIONS)).map((token) => token.rawName);
  if (unknown.length > 0) throw new CliError(`知らないオプションです: ${[...new Set(unknown)].join("、")}\n\n${usage()}`);
  if (rejected.length > 0) {
    const names = [...new Set(rejected.map((token) => token.rawName))].join("、");
    throw new CliError(`${name} が受け取らないオプションです: ${names}\n\n${usage()}`);
  }
  if (positionals.length > 1) throw new CliError(`余分な引数があります: ${positionals.slice(1).join(" ")}\n\n${usage()}`);
  // 1 回だけ指定できるオプションを 2 回指定したときに、後の値を黙って採らない
  for (const option of known) {
    const count = tokens.filter((token) => token.kind === "option" && token.name === option).length;
    if (count > 1 && !("multiple" in OPTIONS[option as OptionName])) {
      throw new CliError(`--${option} が 2 回以上、指定されています`);
    }
  }

  const env = typeof values.env === "string" ? values.env : undefined;
  const config = typeof values.config === "string" ? values.config : undefined;
  const target = resolveTarget({ env, config });
  const context: Context = { target, values: values as Values, config: undefined };

  // どのコマンドも、設定の conference.environment が --env と一致しなければ止まる
  if (command.config === "head") {
    assertEnvironmentMatches(await readConfigFileHead(target.configPath), target.env, target.configPath);
  } else if (command.config === "full") {
    context.config = await readConfigFile(target.configPath, target.env);
  }

  if (command.needsReady) await assertReady(target);
  await command.run(context);
}

main(process.argv.slice(2)).catch((error: unknown) => {
  if (error instanceof CliError) {
    console.error(error.message);
  } else {
    console.error(error);
  }
  process.exitCode = 1;
});
