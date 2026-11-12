import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { ConfigBody } from "../../src/core/config-file.ts";
import type { ServerRecord } from "../../src/core/record.ts";
import { bumpGeneration } from "../../src/cli/commands/bump-generation.ts";
import { exportRecords } from "../../src/cli/commands/export.ts";
import { migrate } from "../../src/cli/commands/migrate.ts";
import { publish, readVersionsText } from "../../src/cli/commands/publish.ts";
import { restoreRecords, restoreStatements } from "../../src/cli/commands/restore-records.ts";
import { assertReady } from "../../src/cli/marks.ts";
import { PROJECT_ROOT } from "../../src/cli/paths.ts";
import { RECORD_COLUMNS, type RecordRow, type RecordsDump, recordToRow, rowToRecord } from "../../src/cli/records-dump.ts";
import { textParam } from "../../src/cli/sql.ts";
import type { Target } from "../../src/cli/target.ts";
import { d1Execute, pendingMigrations } from "../../src/cli/wrangler.ts";
import {
  cancelRecord,
  checkinRecord,
  cloneEnvironment,
  DEVICE_B,
  importSynthetic,
  insertRecords,
  loadLocalConfig,
  migratedEnvironment,
  silent,
  type TestEnvironment,
  TIMEOUT,
  uuid,
} from "./helpers.ts";
import { SYNTHETIC_EVENT_IDS, SYNTHETIC_EVENTS, ticketTokenOf } from "./synthetic-zip.ts";

// DB を戻したときの復旧（Design Doc 8.6）: restore-records、bump-generation と、migrate からの一連の手順。
// wrangler を実際に呼び、ローカルの D1 と KV（一時ディレクトリ）で確かめる。

const T = 1_794_000_000_000;
const D = Date.UTC(2026, 10, 28, 0, 30, 0);
const MAIN = SYNTHETIC_EVENTS.main;
const ticket = (ticketNo: string, userName: string) => ({ ticketToken: ticketTokenOf(MAIN, ticketNo), ticketNo, userName });

// 引用符、改行、;、バックスラッシュ、絵文字を含む値（自由記述、表示名）
const REASON_TEXT = "it's \"別人\"; DROP TABLE records; --\n改行\r\nと\\と🎫";
const OPERATOR_NAME = "受付 '三郎' \"; --";

/** ダンプの記録。日ごとの書き出しの records.json にあたる */
const DUMP_RECORDS: ServerRecord[] = [
  checkinRecord({ id: 1, ...ticket("A-1", "test-alice"), deviceTime: D, receivedAt: D + 5000 }),
  checkinRecord({ id: 2, ...ticket("A-5", "test-carol"), deviceTime: D + 1000, receivedAt: D + 6000, operatorName: OPERATOR_NAME }),
  cancelRecord({ id: 3, ...ticket("A-5", "test-carol"), deviceTime: D + 2000, receivedAt: D + 7000, targets: [2], reasonKind: "other", reasonText: REASON_TEXT, reception: null }),
  checkinRecord({ id: 4, ...ticket("Z-1", "test-erin"), deviceTime: D + 3000, receivedAt: D + 8000, deviceId: DEVICE_B, route: "search" }),
  cancelRecord({ id: 5, ...ticket("Z-1", "test-erin"), deviceTime: D + 4000, receivedAt: D + 9000, targets: [4, 99], reasonKind: "wrong_person" }),
];

const dumpOf = (records: ServerRecord[], environment = "local"): RecordsDump => ({
  format: 0,
  environment,
  generation: "0123456789abcdef0123456789abcdef",
  maxSeq: records.length,
  records,
});

let template: TestEnvironment;
let environment: TestEnvironment;
let config: ConfigBody;

beforeAll(async () => {
  config = await loadLocalConfig();
  template = await migratedEnvironment();
}, TIMEOUT);
afterAll(() => template.cleanup());
afterEach(() => environment?.cleanup());

async function writeDump(name: string, dump: unknown): Promise<string> {
  const path = join(environment.dir, name);
  await writeFile(path, JSON.stringify(dump));
  return path;
}

const storedRecords = async (target: Target): Promise<ServerRecord[]> =>
  (await d1Execute<RecordRow>(target, `SELECT seq, ${RECORD_COLUMNS.join(", ")} FROM records ORDER BY seq`)).map(rowToRecord);

const withoutSeq = (records: ServerRecord[]) => records.map(({ seq: _seq, ...rest }) => rest);
const byRecordId = <R extends { recordId: string }>(records: R[]): R[] => [...records].sort((a, b) => (a.recordId < b.recordId ? -1 : 1));

const generationOf = async (target: Target): Promise<string | undefined> =>
  (await d1Execute<{ value: string }>(target, "SELECT value FROM meta WHERE key = 'generation'"))[0]?.value;

describe("restore-records の文（Design Doc 8.2、8.6）", () => {
  const rows = Array.from({ length: 300 }, (_unused, i) =>
    recordToRow(
      cancelRecord({ id: i + 1, ...ticket("A-1", "test-alice"), deviceTime: D + i, targets: [1], reasonKind: "other", reasonText: "記".repeat(2000) }),
    ),
  );

  it("1 文が 100 KB に収まるように、記録を分ける。値は 16 進で渡し、文に元の値を出さない", () => {
    const statements = restoreStatements(rows);
    expect(statements.length).toBeGreaterThan(1);
    for (const statement of statements) {
      expect(Buffer.byteLength(statement)).toBeLessThan(100_000);
      expect(statement).toMatch(/^INSERT INTO records \([a-z_, ]+\) SELECT [a-z_>' ,-]+ FROM json_each\(CAST\(x'[0-9a-f]+' AS TEXT\)\) WHERE true ON CONFLICT/);
      expect(statement).not.toContain("記");
    }
    // 分けても、すべての記録が、元の順で入る
    const restored = statements.flatMap((statement) => {
      const hex = /x'([0-9a-f]+)'/.exec(statement)?.[1] ?? "";
      return JSON.parse(Buffer.from(hex, "hex").toString("utf8")) as RecordRow[];
    });
    expect(restored).toEqual(rows);
  });

  it("記録がなければ、文を作らない", () => {
    expect(restoreStatements([])).toEqual([]);
  });
});

describe("restore-records", () => {
  it(
    "D1 にない記録は、ダンプの受信時刻で入れる。先に送り直されて別の受信時刻で入った記録は、受信時刻だけをダンプの値に戻す",
    async () => {
      environment = await cloneEnvironment(template);
      const { target } = environment;
      // DB を戻した後、復旧の前に、端末が記録 2 と 3 を送り直した。受信時刻は、送り直した時刻になっている。
      // ダンプになかった記録（ダンプの後に作られ、送り直しで戻った記録）も 1 件ある
      const resent2 = { ...(DUMP_RECORDS[1] as ServerRecord), receivedAt: D + 900_000 };
      const resent3 = { ...(DUMP_RECORDS[2] as ServerRecord), receivedAt: D + 900_001 };
      const later = checkinRecord({ id: 50, ...ticket("A-12", "test-frank"), deviceTime: D + 100_000, receivedAt: D + 900_002 });
      await insertRecords(target, [resent2, resent3, later]);

      const lines: string[] = [];
      await restoreRecords(target, { from: await writeDump("records.json", dumpOf(DUMP_RECORDS)) }, (line) => lines.push(line));
      expect(lines[0]).toContain("5 件");

      const stored = await storedRecords(target);
      // ダンプの記録は、ダンプの受信時刻になる。ダンプになかった記録は、そのまま残る。
      // 引用符、改行、; を含む値（自由記述、表示名）は、そのままの値で保存される
      expect(byRecordId(withoutSeq(stored))).toEqual(byRecordId(withoutSeq([...DUMP_RECORDS, later])));
      // すでにあった記録の連番は変わらず、新しく入った記録には、新しい連番が付く
      expect(stored.map((record) => [record.seq, record.recordId])).toEqual([
        [1, uuid(2)],
        [2, uuid(3)],
        [3, uuid(50)],
        [4, uuid(1)],
        [5, uuid(4)],
        [6, uuid(5)],
      ]);

      // 同じダンプでやり直しても、結果は変わらない
      await restoreRecords(target, { from: join(environment.dir, "records.json") }, silent);
      expect(await storedRecords(target)).toEqual(stored);
    },
    TIMEOUT,
  );

  it(
    "ダンプの環境名が --env と違えば止まる。記録のダンプでないファイルと、読めない形式の版でも止まる",
    async () => {
      environment = await cloneEnvironment(template);
      const { target } = environment;
      const run = async (name: string, dump: unknown) => restoreRecords(target, { from: await writeDump(name, dump) }, silent);

      await expect(run("other-env.json", dumpOf(DUMP_RECORDS, "yapc-tokyo-2026"))).rejects.toThrow(
        /環境 "yapc-tokyo-2026" の書き出しで、--env（"local"）と一致しません/,
      );
      await expect(run("manifest.json", { environment: "local", maxSeq: 5 })).rejects.toThrow(/記録のダンプ（書き出しの records\.json）の形ではありません/);
      await expect(run("future.json", { ...dumpOf(DUMP_RECORDS), format: 99 })).rejects.toThrow(/形式の版（99）を、この版の CLI は読めません/);
      const broken = { ...dumpOf(DUMP_RECORDS), records: [{ ...DUMP_RECORDS[0], op: "delete" }] };
      const message = await run("broken.json", broken).catch((error: Error) => error.message);
      expect(message).toMatch(/records\[0\] が、記録の形ではありません/);
      // 誤りの文言に、記録の値を出さない
      expect(message).not.toContain("test-alice");
      await expect(restoreRecords(target, { from: join(environment.dir, "none.json") }, silent)).rejects.toThrow(/を読めません/);
      expect(await storedRecords(target)).toEqual([]);
    },
    TIMEOUT,
  );
});

describe("bump-generation", () => {
  it(
    "世代を、別の 32 文字の 16 進の値に書き換える",
    async () => {
      environment = await cloneEnvironment(template);
      const before = await generationOf(environment.target);
      await bumpGeneration(environment.target, silent);
      const after = await generationOf(environment.target);
      expect(after).toMatch(/^[0-9a-f]{32}$/);
      expect(after).not.toBe(before);
    },
    TIMEOUT,
  );
});

describe("復旧の手順（Design Doc 8.6 の 2〜5）", () => {
  const ADDED = "9000_test_add_column.sql";

  /**
   * 列を足すマイグレーションを 1 つ多く持つ CLI にあたる対象。いまの migrations/ を一時ディレクトリに写し、
   * 列を足すマイグレーションのフィクスチャを足して、wrangler の設定をそこに向ける。
   * migrations/ の中身（ほかの担当が編集しうる）には、依存しない
   */
  async function withAddedMigration(base: TestEnvironment): Promise<Target> {
    const dir = join(base.dir, "newer-cli");
    await mkdir(dir, { recursive: true });
    await cp(join(PROJECT_ROOT, "migrations"), join(dir, "migrations"), { recursive: true });
    await writeFile(join(dir, "migrations", ADDED), "ALTER TABLE devices ADD COLUMN test_note TEXT;\n");
    const wranglerConfig = join(dir, "wrangler.jsonc");
    await writeFile(
      wranglerConfig,
      JSON.stringify({
        name: "checkin-local",
        compatibility_date: "2026-11-01",
        d1_databases: [{ binding: "DB", database_name: "checkin-local", database_id: "local", migrations_dir: "migrations" }],
        kv_namespaces: [{ binding: "KV", id: "local" }],
      }),
    );
    return { ...base.target, wranglerConfig, migrationsDir: join(dir, "migrations") };
  }

  it(
    "DB を戻した後の状態から、migrate、publish、restore-records、bump-generation が順に通る",
    async () => {
      // DB を戻した後の状態（8.6 の 1 の後）。戻す時点までのマイグレーションだけが適用されていて、
      // 記録は戻す時点までのもの、公開の版は、KV にもう残っていない版を指している
      environment = await cloneEnvironment(template);
      await insertRecords(environment.target, [DUMP_RECORDS[0] as ServerRecord]);
      const restoredVersions = JSON.stringify({ config: T - 50, events: { [SYNTHETIC_EVENT_IDS.main]: T - 40 } });
      await d1Execute(environment.target, `INSERT INTO meta (key, value) VALUES ('versions', ${textParam(restoredVersions)})`);
      const generationBefore = await generationOf(environment.target);

      // 全マイグレーションを持つ CLI
      const target = await withAddedMigration(environment);
      const withTarget = { ...environment, target };

      // 2 の前は、ほかのコマンドがマイグレーションの照合で止まる
      expect(await pendingMigrations(target)).toEqual([ADDED]);
      await expect(assertReady(target)).rejects.toThrow(/適用されていないマイグレーションがあります（9000_test_add_column\.sql）/);

      // 2. migrate。戻した時点より後のマイグレーションを、適用し直す
      await migrate(target, silent);
      expect(await pendingMigrations(target)).toEqual([]);
      await assertReady(target);

      // 3. publish をやり直す。戻った版より新しい取り込みなので、通る
      await importSynthetic(withTarget, config, "main", T + 1);
      await importSynthetic(withTarget, config, "eve", T + 2);
      await importSynthetic(withTarget, config, "party", T + 3);
      await publish(target, config, { now: () => T + 10, log: silent, warn: silent });
      expect(JSON.parse((await readVersionsText(target)) ?? "")).toMatchObject({ config: T + 10 });

      // 4. restore-records
      await restoreRecords(target, { from: await writeDump("records.json", dumpOf(DUMP_RECORDS)) }, silent);
      expect(byRecordId(withoutSeq(await storedRecords(target)))).toEqual(byRecordId(withoutSeq(DUMP_RECORDS)));

      // 5. bump-generation
      await bumpGeneration(target, silent);
      expect(await generationOf(target)).not.toBe(generationBefore);

      // 復旧の後は、書き出しが通り、戻した記録をすべて読む
      const out = join(environment.dir, "out");
      await exportRecords(target, { out }, { now: () => T + 20, release: "test-release", log: silent });
      expect(JSON.parse(await readFile(join(out, "manifest.json"), "utf8"))).toMatchObject({ recordCount: 5, maxSeq: 5 });

      // スキーマは新しいのに、d1_migrations の行がない状態（マイグレーションの途中の時点に戻した）。
      // migrate は、列の重複で失敗する。戻す時点が migrate と deploy の時刻を避ける理由である（8.6 の 1）
      await d1Execute(target, `DELETE FROM d1_migrations WHERE name = '${ADDED}'`);
      expect(await pendingMigrations(target)).toEqual([ADDED]);
      await expect(migrate(target, silent)).rejects.toThrow(/duplicate column name/i);
    },
    TIMEOUT,
  );
});
