import { execFile, spawn } from "node:child_process";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { CliError } from "./errors.ts";
import { PROJECT_ROOT } from "./paths.ts";
import type { Target } from "./target.ts";

// クラウドとの読み書き（Design Doc 8.2）。
// CLI は Worker を通らず、wrangler を子プロセスとして呼んで D1 と KV を直接読み書きする。
// wrangler の呼び出しは、このモジュールに閉じる。wrangler にない操作が要るときは、
// このモジュールの中で REST API を呼ぶ形に替える。
//
// 認証は、環境変数 CLOUDFLARE_API_TOKEN で wrangler に渡る。アカウントは wrangler.jsonc の env の account_id で決まる。

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);

/** wrangler.jsonc のバインディングの名前 */
const D1_BINDING = "DB";
const KV_BINDING = "KV";

const MIGRATIONS_DIR = join(PROJECT_ROOT, "migrations");

// wrangler の exports は bin/ を公開していないので、package.json の場所から辿る
const WRANGLER_BIN = join(dirname(require.resolve("wrangler/package.json")), "bin", "wrangler.js");

/**
 * 対象の環境を選ぶ引数。wrangler には常に --env を付ける。
 * ローカルのときだけ、--env= で最上位の設定を選び、--remote の代わりに --local を付ける
 */
function scopeArgs(target: Target): string[] {
  const config = target.wranglerConfig === undefined ? [] : ["--config", target.wranglerConfig];
  if (!target.local) return [...config, "--env", target.env, "--remote"];
  return [...config, "--env=", "--local", ...(target.persistTo === undefined ? [] : ["--persist-to", target.persistTo])];
}

const childEnv = (): NodeJS.ProcessEnv => ({ ...process.env, WRANGLER_SEND_METRICS: "false" });

/** wrangler を実行して、標準出力を返す */
async function run(args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync(process.execPath, [WRANGLER_BIN, ...args], {
      cwd: PROJECT_ROOT,
      env: childEnv(),
      maxBuffer: 256 * 1024 * 1024,
    });
    return stdout;
  } catch (error) {
    const { stdout = "", stderr = "", code } = error as { stdout?: string; stderr?: string; code?: unknown };
    // 文は出さない。値は 16 進で渡しているので、wrangler の出力にも元の値は現れない
    const output = `${stdout}\n${stderr}`.trim();
    const detail = output === "" ? `起動できませんでした（${String(code)}）` : output;
    throw new CliError(`wrangler ${args.slice(0, 3).join(" ")} が失敗しました\n${detail}`);
  }
}

/** wrangler を、端末につないで実行する。確認の表示に管理者が答えられるようにする */
function runInteractive(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [WRANGLER_BIN, ...args], {
      cwd: PROJECT_ROOT,
      env: childEnv(),
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new CliError(`wrangler ${args.slice(0, 3).join(" ")} が失敗しました（終了コード ${code}）`));
    });
  });
}

type D1Result<Row> = { results: Row[]; success: boolean };

/** D1 で文を実行して、行を返す。値は jsonParam（sql.ts）で文に渡す */
export async function d1Execute<Row = Record<string, unknown>>(target: Target, sql: string): Promise<Row[]> {
  const stdout = await run(["d1", "execute", D1_BINDING, ...scopeArgs(target), "--json", "--command", sql]);
  const last = parseJsonOutput<D1Result<Row>[]>(stdout, "d1 execute").at(-1);
  if (last === undefined || !last.success) throw new CliError("D1 の文の実行に失敗しました");
  return last.results;
}

/**
 * wrangler の標準出力から、JSON の配列を取り出す。配列の前に、wrangler の知らせが出ていることがある。
 * 知らせにも「[」が現れうるので、行の先頭の「[」を前から順に試し、最初に JSON として読めたところを使う
 */
export function parseJsonOutput<T>(stdout: string, what: string): T {
  for (const match of stdout.matchAll(/^\[/gm)) {
    try {
      return JSON.parse(stdout.slice(match.index)) as T;
    } catch {
      // 知らせの行だった。次の候補を試す
    }
  }
  throw new CliError(`wrangler ${what} の出力を JSON として読めません`);
}

/** migrations/ にあるマイグレーションのファイル名。適用する順 */
export async function localMigrations(target?: Pick<Target, "migrationsDir">): Promise<string[]> {
  const names = await readdir(target?.migrationsDir ?? MIGRATIONS_DIR);
  return names.filter((name) => name.endsWith(".sql")).sort();
}

/**
 * CLI が持つマイグレーションのうち、D1 にまだ適用されていないもの（Design Doc 8.1、9.5）。
 * 適用済みかは、wrangler と同じくファイル名で決める
 */
export async function pendingMigrations(target: Target): Promise<string[]> {
  const applied = new Set(await appliedMigrations(target));
  return (await localMigrations(target)).filter((name) => !applied.has(name));
}

/** D1 に適用済みのマイグレーションのファイル名。適用した順 */
async function appliedMigrations(target: Target): Promise<string[]> {
  const hasTable = await d1Execute(
    target,
    "SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'd1_migrations'",
  );
  if (hasTable.length === 0) return [];
  return (await d1Execute<{ name: string }>(target, "SELECT name FROM d1_migrations ORDER BY id")).map((row) => row.name);
}

/**
 * D1 に適用済みのマイグレーションのうち、CLI が持たないもの。あれば、その D1 は、既存のマイグレーションの
 * ファイルを書き換えるか改名する前の版で作られている（Design Doc 9.6）
 */
export async function unknownAppliedMigrations(target: Target): Promise<string[]> {
  const local = new Set(await localMigrations(target));
  return (await appliedMigrations(target)).filter((name) => !local.has(name));
}

/**
 * D1 にマイグレーションを適用する（wrangler d1 migrations apply）。
 * wrangler は、適用の前に確認を求める。リモートでは端末につないで、管理者が答える。
 * ローカルでは端末につながず、確認なしで進ませる。開発の起動とテストを、入力待ちで止めないためである
 */
export async function applyMigrations(target: Target): Promise<void> {
  const args = ["d1", "migrations", "apply", D1_BINDING, ...scopeArgs(target)];
  if (target.local) await run(args);
  else await runInteractive(args);
}

/**
 * KV の値を読む。鍵がなければ null。
 * wrangler の kv key get は、鍵がなくても成功して「Value not found」を出すので、先に鍵の有無を一覧で確かめる
 */
export async function kvGet(target: Target, key: string): Promise<string | null> {
  const listed = await run(["kv", "key", "list", "--binding", KV_BINDING, ...scopeArgs(target), "--prefix", key]);
  const keys = parseJsonOutput<{ name: string }[]>(listed, "kv key list");
  if (!keys.some((entry) => entry.name === key)) return null;
  // --text は付けない。付けると、値の後ろに改行が足される
  return run(["kv", "key", "get", key, "--binding", KV_BINDING, ...scopeArgs(target)]);
}

/** KV に値を書く。値はファイルで渡し、引数に載せない */
export async function kvPut(target: Target, key: string, value: string): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "checkin-kv-"));
  try {
    const path = join(dir, "value");
    await writeFile(path, value, "utf8");
    await run(["kv", "key", "put", key, "--binding", KV_BINDING, ...scopeArgs(target), "--path", path]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** KV の鍵のうち、名前が prefix で始まるものの一覧 */
export async function kvList(target: Target, prefix: string): Promise<string[]> {
  const listed = await run(["kv", "key", "list", "--binding", KV_BINDING, ...scopeArgs(target), "--prefix", prefix]);
  return parseJsonOutput<{ name: string }[]>(listed, "kv key list").map((entry) => entry.name);
}

/** KV の鍵を消す */
export async function kvDelete(target: Target, key: string): Promise<void> {
  await run(["kv", "key", "delete", key, "--binding", KV_BINDING, ...scopeArgs(target)]);
}

/**
 * D1 で、文を並べたファイルを実行する（wrangler d1 execute --file）。文の多い restore-records だけが使う（Design Doc 8.2）。
 * リモートの --file は import の経路を通り、処理の間 DB が要求を受け付けなくなる。wrangler がその確認を求めるので、
 * リモートでは端末につないで、管理者が答える。ローカルでは端末につながない
 */
export async function d1ExecuteFile(target: Target, sql: string): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "checkin-sql-"));
  try {
    const path = join(dir, "statements.sql");
    await writeFile(path, sql, "utf8");
    const args = ["d1", "execute", D1_BINDING, ...scopeArgs(target), "--file", path];
    if (target.local) await run(args);
    else await runInteractive(args);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * ビルドの出力をデプロイする（wrangler deploy）。deploy だけが使う（Design Doc 8.1）。
 * ビルド（vite build）が、その環境に向けた wrangler の設定を出力し、wrangler はそれを読む。
 * --env がビルドの環境と違えば、wrangler が止まる。デプロイの記録に、リリース名を残す
 */
export async function deployWorker(target: Target, release: string): Promise<void> {
  if (target.local) throw new CliError("ローカルの開発の環境（local）には、デプロイしません");
  await runInteractive(["deploy", "--env", target.env, "--message", release]);
}
