import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "../../src/cli/commands/migrate.ts";
import { assertReady, readMarks } from "../../src/cli/marks.ts";
import { jsonParam } from "../../src/cli/sql.ts";
import type { Target } from "../../src/cli/target.ts";
import { d1Execute, kvPut, localMigrations, pendingMigrations } from "../../src/cli/wrangler.ts";

// wrangler を実際に呼び、ローカルの D1 と KV（一時ディレクトリ）で確かめる（Design Doc 11 章の cli）。
// wrangler の起動を何度も伴うので、時間の上限を延ばす

const TIMEOUT = 180_000;
const silent = (): void => {};

let target: Target;

beforeEach(async () => {
  const persistTo = await mkdtemp(join(tmpdir(), "checkin-cli-test-"));
  target = { env: "local", local: true, configPath: "", workDir: "", persistTo };
});

afterEach(async () => {
  if (target.persistTo !== undefined) await rm(target.persistTo, { recursive: true, force: true });
});

describe("migrate と環境の印（Design Doc 3.6、8.1）", () => {
  it(
    "マイグレーションを適用し、印のない D1 と KV に環境名を書く。2 回目は何も書かない",
    async () => {
      expect(await readMarks(target)).toEqual({ d1: null, kv: null });
      expect(await pendingMigrations(target)).toEqual(await localMigrations());

      const lines: string[] = [];
      await migrate(target, (line) => lines.push(line));
      expect(await readMarks(target)).toEqual({ d1: "local", kv: "local" });
      expect(await pendingMigrations(target)).toEqual([]);
      expect(lines.filter((line) => line.includes("環境の印"))).toHaveLength(2);

      const again: string[] = [];
      await migrate(target, (line) => again.push(line));
      expect(again.filter((line) => line.includes("環境の印"))).toHaveLength(0);
      await assertReady(target);
    },
    TIMEOUT,
  );

  it(
    "KV の印が違えば、マイグレーションを適用する前に止まる",
    async () => {
      await kvPut(target, "environment", "another-conference");
      await expect(migrate(target, silent)).rejects.toThrow(/KV の環境の印/);
      expect(await pendingMigrations(target)).toEqual(await localMigrations());
    },
    TIMEOUT,
  );

  it(
    "D1 の印が違えば止まり、印のないほうにだけ書く",
    async () => {
      await migrate(target, silent);
      await d1Execute(target, "UPDATE meta SET value = 'another-conference' WHERE key = 'environment'");
      await expect(migrate(target, silent)).rejects.toThrow(/D1 の環境の印/);
      await expect(assertReady(target)).rejects.toThrow(/D1 の環境の印/);

      // D1 だけを作り直したとき（v1 への切り替え）は、KV の印が残り、D1 の印だけを書く
      await d1Execute(target, "DELETE FROM meta WHERE key = 'environment'");
      const lines: string[] = [];
      await migrate(target, (line) => lines.push(line));
      expect(lines.filter((line) => line.includes("環境の印"))).toEqual(["D1 に環境の印（local）を書きました"]);
    },
    TIMEOUT,
  );

  it(
    "migrate の前は、ほかのコマンドの照合が止まる",
    async () => {
      await expect(assertReady(target)).rejects.toThrow(/migrate --env local/);
    },
    TIMEOUT,
  );
});

describe("SQL に渡す値（Design Doc 8.2、12.2）", () => {
  it(
    "引用符、改行、; を含む値が、そのままの値で保存される",
    async () => {
      await migrate(target, silent);
      const value = "it's \"quoted\"; DROP TABLE meta; --\n改行\r\nと\\バックスラッシュと🎫と\u0000の前まで";
      const param = jsonParam({ key: "probe", value });
      await d1Execute(
        target,
        `INSERT INTO meta (key, value) SELECT ${param} ->> '$.key', ${param} ->> '$.value'`,
      );
      const rows = await d1Execute<{ value: string }>(target, "SELECT value FROM meta WHERE key = 'probe'");
      expect(rows).toEqual([{ value }]);
    },
    TIMEOUT,
  );

  it(
    "100 KB に近い 1 文が --command で通る",
    async () => {
      await migrate(target, silent);
      const value = "記".repeat(15_000); // UTF-8 で 45 KB、16 進で 90 KB
      const sql = `INSERT INTO meta (key, value) VALUES ('large', ${jsonParam({ value })} ->> '$.value')`;
      expect(Buffer.byteLength(sql)).toBeGreaterThan(90_000);
      expect(Buffer.byteLength(sql)).toBeLessThan(100_000);
      await d1Execute(target, sql);
      const rows = await d1Execute<{ n: number }>(target, "SELECT length(value) AS n FROM meta WHERE key = 'large'");
      expect(rows).toEqual([{ n: 15_000 }]);
    },
    TIMEOUT,
  );
});
