import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PROJECT_ROOT } from "../../src/cli/paths.ts";

// CLI を、手順書と同じ形（node src/cli/main.ts）で起動して確かめる。
// ここで確かめるのは、D1 と KV に触れる前に止まる経路だけである

type Result = { code: number; stdout: string; stderr: string };

function cli(...args: string[]): Promise<Result> {
  return new Promise((resolve) => {
    execFile(process.execPath, [join(PROJECT_ROOT, "src/cli/main.ts"), ...args], { cwd: PROJECT_ROOT }, (error, stdout, stderr) => {
      resolve({ code: error === null ? 0 : typeof error.code === "number" ? error.code : 1, stdout, stderr });
    });
  });
}

let dir: string;
const config = (name: string) => join(dir, name);

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "checkin-cli-main-"));
  await writeFile(config("broken.toml"), '[conference]\nslug = ""\nname = 1\n');
  await writeFile(
    config("many-errors.toml"),
    [
      "[conference]",
      'slug = "x"',
      'name = "X"',
      'timezone = "Asia/Tokyo"',
      'environment = "another-conference"',
      "[[events]]",
      'id = "event-1"',
      'name = "本編"',
      'key = "main"',
      "[[receptions]]",
      'id = "main"',
      'name = "本編受付"',
      "periods = [{ start = 2026-11-28T09:30:00, end = 2026-11-28T17:30:00 }]",
      "accept = []",
      'require = ["main"]',
      'checkin = ["main"]',
      'rejectMessage = "本編チケットがありません"',
      "[template]",
      'reference = "{{user.nickname}}"',
      "",
    ].join("\n"),
  );
  await writeFile(
    config("other-env.toml"),
    '[conference]\nslug = "x"\nname = "X"\ntimezone = "Asia/Tokyo"\nenvironment = "another-conference"\n',
  );
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("管理 CLI の入口（Design Doc 8.1）", () => {
  it("--help は使い方を出して成功する", async () => {
    const result = await cli("--help");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("使い方:");
    expect(result.stdout).toContain("migrate");
  });

  it("--env に既定値はない", async () => {
    const result = await cli("migrate");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("--env <環境名> を指定してください");
  });

  it("知らないコマンドで止まる", async () => {
    const result = await cli("frobnicate", "--env", "local");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("知らないコマンドです: frobnicate");
  });

  it("打ち間違えたオプションを、黙って無視しない", async () => {
    // --config の打ち間違い。無視すると、既定の設定ファイルで先へ進む
    const result = await cli("migrate", "--env", "local", "--confg", config("other-env.toml"));
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("知らないオプションです: --confg");
  });

  it.each([
    ["--config の値がない", ["migrate", "--env", "local", "--config"], "--config には値が要ります"],
    ["--config が次のオプションを値として取り込む", ["migrate", "--config", "--env", "local"], "--config には値が要ります"],
    ["--env の値がない", ["migrate", "--env"], "--env には値が要ります"],
    ["どのコマンドでも、値のない --config", ["validate", "--env", "local", "--config"], "--config には値が要ります"],
    ["--event の値がない", ["import", "--env", "local", "--zip", "x.zip", "--event"], "--event には値が要ります"],
    ["--zip が次のオプションを値として取り込む", ["import", "--env", "local", "--zip", "--event", "main"], "--zip には値が要ります"],
    ["--out の値がない", ["export", "--env", "local", "--out"], "--out には値が要ります"],
    ["--done の値がない", ["preview", "--env", "local", "--event", "main", "--ticket", "A-1", "--done"], "--done には値が要ります"],
    ["--from の値がない", ["restore-records", "--env", "local", "--from"], "--from には値が要ります"],
  ])("値を取るオプションに値がなければ、省略として扱わずに止まる: %s", async (_name, args, message) => {
    // 省略として扱うと、既定の設定ファイル（config/local.toml）で先へ進む
    const result = await cli(...args);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(message);
  });

  it("値は = でつないでも渡せる", async () => {
    const result = await cli("migrate", "--env=local", `--config=${config("other-env.toml")}`);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("conference.environment");
  });

  it("余分な引数で止まる", async () => {
    const result = await cli("migrate", "extra", "--env", "local");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("余分な引数があります: extra");
  });

  it("設定の conference.environment が --env と違えば止まる", async () => {
    const result = await cli("migrate", "--env", "local", "--config", config("other-env.toml"));
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('conference.environment（"another-conference"）が --env（"local"）と一致しません');
  });

  it("設定の誤りを、項目ごとに日本語で列挙する", async () => {
    const result = await cli("migrate", "--env", "local", "--config", config("broken.toml"));
    expect(result.code).toBe(1);
    expect(result.stderr).not.toContain("Invalid input");
    expect(result.stderr).toMatch(/conference\.slug: .*1文字以上/);
    expect(result.stderr).toMatch(/conference\.name: .*string/);
    expect(result.stderr).toMatch(/conference\.timezone: /);
    expect(result.stderr).toMatch(/conference\.environment: /);
  });

  it.each([
    ["import に --out", ["import", "--env", "local", "--event", "main", "--zip", "x.zip", "--out", "dir"], "import が受け取らないオプションです: --out"],
    ["publish に --event", ["publish", "--env", "local", "--event", "main"], "publish が受け取らないオプションです: --event"],
    ["validate に知らないオプション", ["validate", "--env", "local", "--strict"], "知らないオプションです: --strict"],
    ["export に打ち間違えたオプション", ["export", "--env", "local", "--out", "dir", "--chunks", "100"], "知らないオプションです: --chunks"],
    ["deploy に --dry-run", ["deploy", "--env", "local", "--dry-run"], "知らないオプションです: --dry-run"],
  ])("そのコマンドが受け取らないオプションで、D1 と KV に触れる前に止まる: %s", async (_name, args, message) => {
    const result = await cli(...args);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(message);
  });

  it.each([
    ["import の --event", ["import", "--env", "local", "--zip", "x.zip"], "--event <値> を指定してください"],
    ["import の --zip", ["import", "--env", "local", "--event", "main"], "--zip <値> を指定してください"],
    ["preview の --ticket", ["preview", "--env", "local", "--event", "main"], "--ticket <値> を指定してください"],
  ])("必須のオプションがなければ止まる: %s", async (_name, args, message) => {
    const result = await cli(...args);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(message);
  });

  it("1 回だけ指定できるオプションを 2 回指定すると、後の値を黙って採らずに止まる", async () => {
    const result = await cli("import", "--env", "local", "--event", "main", "--event", "eve", "--zip", "x.zip");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("--event が 2 回以上、指定されています");
  });

  it("validate は、設定ファイルの誤りを、--env との不一致も含めてすべて列挙して、非ゼロで終わる", async () => {
    const result = await cli("validate", "--env", "local", "--config", config("many-errors.toml"));
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("に誤りがあります（3 件）");
    expect(result.stderr).toMatch(/conference\.environment: "another-conference" が --env（"local"）と一致しません/);
    expect(result.stderr).toMatch(/receptions\[0\]\.checkin\[0\]: /);
    expect(result.stderr).toMatch(/template\.reference: /);
  });

  it("validate は、正しい設定で成功する", async () => {
    const result = await cli("validate", "--env", "local");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("誤りはありません");
  });

  it("設定ファイル全体を読むコマンド（import、preview、publish）は、設定に誤りがあれば、すべて列挙して止まる", async () => {
    const result = await cli("import", "--env", "another-conference", "--config", config("many-errors.toml"), "--event", "main", "--zip", "x.zip");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("に誤りがあります（2 件）");
  });
});
