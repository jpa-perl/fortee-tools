import { parseArgs } from "node:util";
import { configureJapaneseMessages } from "../core/messages.ts";
import { migrate } from "./commands/migrate.ts";
import { assertEnvironmentMatches, readConfigFileHead } from "./config-file.ts";
import { CliError } from "./errors.ts";
import { assertReady } from "./marks.ts";
import { resolveTarget, type Target } from "./target.ts";

// 管理 CLI の入口（Design Doc 8.1）。1 つの実行ファイルにサブコマンドを持たせる。
// すべてのコマンドは --env <環境名> で対象の環境を受け取り、既定値を持たない。
// 参加者の情報をログに出さない（Design Doc 9.3）。

type Command = {
  summary: string;
  /** D1 と KV を読み書きする前に、環境の印とマイグレーションを照合するか（Design Doc 8.1） */
  needsReady: boolean;
  run?: (target: Target) => Promise<void>;
  /** --env、--config、--help のほかに、このコマンドが受け取るオプションの名前 */
  options?: string[];
  /** まだ実装していないコマンドの、設計の節 */
  pending?: string;
};

/** どのコマンドも受け取るオプション */
const GLOBAL_OPTIONS = {
  env: { type: "string" },
  config: { type: "string" },
  help: { type: "boolean", short: "h" },
} as const;

const log = (line: string): void => {
  console.log(line);
};

const COMMANDS: Record<string, Command> = {
  validate: { summary: "設定ファイルを検証する", needsReady: false, pending: "4.2、8.7" },
  import: { summary: "fortee の ZIP からスナップショットを作る", needsReady: false, pending: "8.3" },
  preview: { summary: "参考情報テンプレートを描画する", needsReady: false, pending: "8.7" },
  publish: { summary: "スナップショットと設定を公開する", needsReady: true, pending: "8.4" },
  export: { summary: "記録から書き出しの各ファイルを作る", needsReady: true, pending: "8.5" },
  "restore-records": { summary: "書き出しの記録のダンプを D1 に戻す", needsReady: true, pending: "8.6" },
  "bump-generation": { summary: "世代を書き換える", needsReady: true, pending: "8.6" },
  // migrate は印を書く側で、これからマイグレーションを適用するので、ある印の照合だけを自分で行う
  migrate: { summary: "D1 にマイグレーションを適用し、環境の印を書く", needsReady: false, run: (t) => migrate(t, log) },
  deploy: { summary: "ビルドしてデプロイする", needsReady: true, pending: "3.5、8.1" },
};

function usage(): string {
  const width = Math.max(...Object.keys(COMMANDS).map((name) => name.length));
  const lines = Object.entries(COMMANDS).map(
    ([name, command]) => `  ${name.padEnd(width)}  ${command.summary}${command.pending ? "（未実装）" : ""}`,
  );
  return [
    "使い方: npm run cli -- <コマンド> --env <環境名> [--config <TOML>]",
    "",
    "コマンド:",
    ...lines,
    "",
    "--env は必須で、既定値はありません。ローカルの開発は --env local です。",
  ].join("\n");
}

async function main(argv: string[]): Promise<void> {
  // 設定ファイルの誤りを、読める文言で出す
  configureJapaneseMessages();

  const { values, positionals, tokens } = parseArgs({
    args: argv,
    allowPositionals: true,
    // 知らないオプションは、コマンドが分かってから下で確かめる
    strict: false,
    tokens: true,
    options: GLOBAL_OPTIONS,
  });

  // 値を取るオプションに値がないことを、省略と区別する。区別しないと、値のない --config が
  // 指定のないものとして扱われ、既定の設定ファイルで先へ進む
  for (const token of tokens) {
    if (token.kind !== "option" || !(token.name in GLOBAL_OPTIONS)) continue;
    if (GLOBAL_OPTIONS[token.name as keyof typeof GLOBAL_OPTIONS].type !== "string") continue;
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

  // 実装済みのコマンドでは、知らないオプションと余分な引数を誤りにする。黙って無視すると、
  // --config を打ち間違えたときに、既定の設定ファイルで先へ進んでしまう。
  // まだ実装していないコマンドは、受け取るオプションが決まっていないので確かめない
  if (command.run !== undefined) {
    const known = new Set([...Object.keys(GLOBAL_OPTIONS), ...(command.options ?? [])]);
    const unknown = tokens.flatMap((token) => (token.kind === "option" && !known.has(token.name) ? [token.rawName] : []));
    if (unknown.length > 0) throw new CliError(`知らないオプションです: ${unknown.join("、")}\n\n${usage()}`);
    if (positionals.length > 1) throw new CliError(`余分な引数があります: ${positionals.slice(1).join(" ")}\n\n${usage()}`);
  }

  const env = typeof values.env === "string" ? values.env : undefined;
  const config = typeof values.config === "string" ? values.config : undefined;
  const target = resolveTarget({ env, config });

  // どのコマンドも、設定の conference.environment が --env と一致しなければ止まる
  assertEnvironmentMatches(await readConfigFileHead(target.configPath), target.env, target.configPath);

  if (command.run === undefined) {
    if (command.needsReady) await assertReady(target);
    throw new CliError(`${name} はまだ実装していません（Design Doc ${command.pending}）`);
  }
  await command.run(target);
}

main(process.argv.slice(2)).catch((error: unknown) => {
  if (error instanceof CliError) {
    console.error(error.message);
  } else {
    console.error(error);
  }
  process.exitCode = 1;
});
