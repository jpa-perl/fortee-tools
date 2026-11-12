import { beforeEach, describe, expect, it, vi } from "vitest";
import { migrate } from "../../src/cli/commands/migrate.ts";
import type { Target } from "../../src/cli/target.ts";
import * as wrangler from "../../src/cli/wrangler.ts";

// wrangler は、マイグレーションの適用の確認で取り消されても、成功として終わる（wrangler 4.157.0 の実装）。
// 確認は端末がないと出ないので、取り消しを wrangler の呼び出しの差し替えで再現する

vi.mock("../../src/cli/wrangler.ts", () => ({
  applyMigrations: vi.fn(),
  pendingMigrations: vi.fn(),
  localMigrations: vi.fn(),
  d1Execute: vi.fn(),
  kvGet: vi.fn(),
  kvPut: vi.fn(),
}));

const target: Target = { env: "yapc-tokyo-2026", local: false, configPath: "", workDir: "" };

/** meta の表はあるが、D1 にも KV にも環境の印がまだない環境 */
function unmarkedEnvironment(): void {
  vi.mocked(wrangler.d1Execute).mockImplementation(async (_target, sql) =>
    sql.includes("sqlite_master") ? [{ found: 1 }] : [],
  );
  vi.mocked(wrangler.kvGet).mockResolvedValue(null);
  vi.mocked(wrangler.kvPut).mockResolvedValue(undefined);
  // 適用の確認で取り消されても、wrangler は成功として終わる
  vi.mocked(wrangler.applyMigrations).mockResolvedValue(undefined);
}

const wroteD1Mark = () =>
  vi.mocked(wrangler.d1Execute).mock.calls.some(([, sql]) => sql.includes("INSERT INTO meta"));

beforeEach(() => {
  vi.resetAllMocks();
  unmarkedEnvironment();
});

describe("migrate で、適用が取り消されたとき（Design Doc 8.1）", () => {
  it("未適用のマイグレーションが残っていれば、環境の印を書かず、終わったとも知らせない", async () => {
    vi.mocked(wrangler.pendingMigrations).mockResolvedValue(["0001_add_column.sql"]);
    const lines: string[] = [];

    await expect(migrate(target, (line) => lines.push(line))).rejects.toThrow(
      /マイグレーションが適用されていません（0001_add_column\.sql）/,
    );
    expect(wrangler.applyMigrations).toHaveBeenCalledOnce();
    expect(wrangler.kvPut).not.toHaveBeenCalled();
    expect(wroteD1Mark()).toBe(false);
    expect(lines).toEqual([]);
  });

  it("すべて適用されていれば、印のないほうへ環境名を書いて終わる", async () => {
    vi.mocked(wrangler.pendingMigrations).mockResolvedValue([]);
    const lines: string[] = [];

    await migrate(target, (line) => lines.push(line));
    expect(wrangler.kvPut).toHaveBeenCalledWith(target, "environment", "yapc-tokyo-2026");
    expect(wroteD1Mark()).toBe(true);
    expect(lines.at(-1)).toBe("migrate が終わりました（環境 yapc-tokyo-2026）");
  });
});
