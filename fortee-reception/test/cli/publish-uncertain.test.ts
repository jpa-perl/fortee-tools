import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConfigBody } from "../../src/core/config-file.ts";
import { publish } from "../../src/cli/commands/publish.ts";
import { CliError } from "../../src/cli/errors.ts";
import * as wrangler from "../../src/cli/wrangler.ts";
import { importSynthetic, loadLocalConfig, silent, temporaryEnvironment, type TestEnvironment } from "./helpers.ts";
import { SYNTHETIC_EVENT_IDS } from "./synthetic-zip.ts";

// 公開の 8（版の切り替え）の結果が、通信の切断で分からないとき（Design Doc 8.8）。
// meta.versions を読み直し、書こうとした値なら 9 へ進み、3 で控えた値ならやり直しを求め、どちらでもなければ競合として止まる。
// 切断は、wrangler の呼び出しの差し替えで再現する

vi.mock("../../src/cli/wrangler.ts", () => ({
  applyMigrations: vi.fn(),
  pendingMigrations: vi.fn(),
  localMigrations: vi.fn(),
  d1Execute: vi.fn(),
  d1ExecuteFile: vi.fn(),
  kvGet: vi.fn(),
  kvPut: vi.fn(),
  kvList: vi.fn(),
  kvDelete: vi.fn(),
  deployWorker: vi.fn(),
}));

const T = 1_794_000_000_000;
const { main: MAIN, eve: EVE, party: PARTY } = SYNTHETIC_EVENT_IDS;
const PREVIOUS = JSON.stringify({ config: T - 10, events: { [MAIN]: T - 9, [EVE]: T - 8, [PARTY]: T - 7 } });
const NEXT = JSON.stringify({ config: T + 10, events: { [MAIN]: T + 1, [EVE]: T + 2, [PARTY]: T + 3 } });

let environment: TestEnvironment;
let config: ConfigBody;

beforeAll(async () => {
  config = await loadLocalConfig();
  environment = await temporaryEnvironment();
  await importSynthetic(environment, config, "main", T + 1);
  await importSynthetic(environment, config, "eve", T + 2);
  await importSynthetic(environment, config, "party", T + 3);
});
afterAll(() => environment.cleanup());

/** 版の切り替えの文が失敗し、その後の読み直しで afterFailure が読める D1 */
function d1(afterFailure: string | null): void {
  let failed = false;
  vi.mocked(wrangler.d1Execute).mockImplementation(async (_target, sql) => {
    if (sql.startsWith("INSERT INTO meta")) {
      failed = true;
      throw new CliError("wrangler d1 execute DB が失敗しました\n通信が切れた");
    }
    const value = failed ? afterFailure : PREVIOUS;
    return value === null ? [] : [{ value }];
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  // KV には、前の版のキーと、どの版からも指されないキーがある
  vi.mocked(wrangler.kvList).mockImplementation(async (_target, prefix) =>
    prefix === "config:" ? [`config:${T - 10}`, `config:${T - 20}`] : [`snapshot:${MAIN}:${T - 9}`, `snapshot:${MAIN}:${T - 19}`],
  );
});

const run = () => publish(environment.target, config, { now: () => T + 10, log: silent, warn: silent });
const deleted = () => vi.mocked(wrangler.kvDelete).mock.calls.map(([, key]) => key);

describe("publish: 版の切り替えの結果が分からないとき", () => {
  it("読み直した値が、書こうとした値なら、掃除へ進む", async () => {
    d1(NEXT);
    await run();
    expect(deleted().sort()).toEqual([`config:${T - 20}`, `snapshot:${MAIN}:${T - 19}`].sort());
  });

  it("読み直した値が、控えた値のままなら、やり直しを求めて止まり、掃除をしない", async () => {
    d1(PREVIOUS);
    await expect(run()).rejects.toThrow(/版を書き換えられませんでした。前の版のままです。publish をやり直してください/);
    expect(deleted()).toEqual([]);
  });

  it("読み直した値が、どちらでもなければ、競合として止まり、掃除をしない", async () => {
    d1(JSON.stringify({ config: T + 5, events: {} }));
    await expect(run()).rejects.toThrow(/公開の競合です/);
    expect(deleted()).toEqual([]);
  });

  it("版の切り替えの文は、控えた文字列をそのまま比べ、値を 16 進で渡す", async () => {
    vi.mocked(wrangler.d1Execute).mockImplementation(async (_target, sql) => (sql.startsWith("INSERT INTO meta") ? [{ key: "versions" }] : [{ value: PREVIOUS }]));
    await run();
    const sql = vi.mocked(wrangler.d1Execute).mock.calls.map(([, statement]) => statement).find((statement) => statement.startsWith("INSERT INTO meta"));
    const hex = (text: string) => Buffer.from(text, "utf8").toString("hex");
    expect(sql).toBe(
      `INSERT INTO meta (key, value) VALUES ('versions', CAST(x'${hex(NEXT)}' AS TEXT)) ` +
        `ON CONFLICT (key) DO UPDATE SET value = excluded.value WHERE meta.value = CAST(x'${hex(PREVIOUS)}' AS TEXT) RETURNING key`,
    );
  });
});
