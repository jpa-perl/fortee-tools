import { mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "csv-parse/sync";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ConfigBody } from "../../src/core/config-file.ts";
import type { ServerRecord } from "../../src/core/record.ts";
import { bumpGeneration } from "../../src/cli/commands/bump-generation.ts";
import { type ExportDeps, type ExportOptions, exportRecords } from "../../src/cli/commands/export.ts";
import { publish } from "../../src/cli/commands/publish.ts";
import { PROJECT_ROOT } from "../../src/cli/paths.ts";
import { parseRecordsDump } from "../../src/cli/records-dump.ts";
import { kvDelete } from "../../src/cli/wrangler.ts";
import {
  cancelRecord,
  checkinRecord,
  DEVICE_A,
  DEVICE_B,
  importSynthetic,
  insertDevices,
  insertRecords,
  loadLocalConfig,
  migratedEnvironment,
  silent,
  type TestEnvironment,
  TIMEOUT,
} from "./helpers.ts";
import { profileUrlTokenOf, SYNTHETIC_EVENTS, syntheticToken, ticketTokenOf } from "./synthetic-zip.ts";

// 書き出し（Design Doc 8.5、FR-45）。wrangler を実際に呼び、ローカルの D1 と KV（一時ディレクトリ）で確かめる。
// スナップショットは、合成の ZIP（synthetic-zip.ts。Sandbox の本物の ZIP ではない）から取り込んで公開したもので、
// 記録は、Worker の同期の代わりに、テストが D1 に直接入れる。
// テストは、1 つの環境を順に使う。記録を足すテストは、後ろに置く。

const GOLDEN = join(PROJECT_ROOT, "test", "cli", "golden", "export");
const T = 1_794_000_000_000;
// 2026-11-28 09:30:00（Asia/Tokyo）
const D = Date.UTC(2026, 10, 28, 0, 30, 0);
const NOW = Date.UTC(2026, 10, 28, 12, 0, 0);
const sec = (seconds: number) => D + seconds * 1000;

const { main: MAIN, eve: EVE } = SYNTHETIC_EVENTS;
const main = (ticketNo: string, userName: string) => ({ ticketToken: ticketTokenOf(MAIN, ticketNo), ticketNo, userName });

const ALICE = main("A-1", "test-alice");
const CAROL = main("A-5", "test-carol");
const DAVE = main("A-6", "test-dave");
const ERIN = main("Z-1", "test-erin");
const FRANK = main("A-12", "test-frank");
const CAROL_EVE = { ticketToken: ticketTokenOf(EVE, "M-2"), ticketNo: "M-2", userName: "test-carol" };
// 現在のスナップショットにないチケット。前回の取り込みの後に、キャンセルされた参加者
const GONE = { ticketToken: syntheticToken("gone-1"), ticketNo: "A-99", userName: "test-gone" };
const GONE_CANCELLED = { ticketToken: syntheticToken("gone-2"), ticketNo: "A-98", userName: "test-gone, \"引用符\"" };

const REASON_TEXT = "it's \"別のチケット\"; DROP TABLE records; --\n改行と\\と🎫";

const RECORDS: ServerRecord[] = [
  // 済み
  checkinRecord({ id: 1, ...ALICE, deviceTime: sec(0) }),
  // チェックインして、取り消した。未
  checkinRecord({ id: 2, ...CAROL, deviceTime: sec(60) }),
  cancelRecord({ id: 3, ...CAROL, deviceTime: sec(120), targets: [2] }),
  // 取り消した後に、再チェックインした。取り消しは、受付なしのときに、別の端末から行った
  checkinRecord({ id: 4, ...DAVE, deviceTime: sec(200) }),
  cancelRecord({
    id: 5,
    ...DAVE,
    deviceTime: sec(300),
    targets: [4],
    deviceId: DEVICE_B,
    reception: null,
    reasonKind: "other",
    reasonText: REASON_TEXT,
    operatorId: "987654321098765432",
    operatorName: "受付 \"二郎\"; '",
  }),
  checkinRecord({ id: 6, ...DAVE, deviceTime: sec(400), deviceId: DEVICE_B, route: "search", operatorId: "987654321098765432", operatorName: "受付 \"二郎\"; '" }),
  // 2 台の端末が、同じチケットをチェックインした（FR-41）。端末 A は、端末 B の記録を受信しないまま、自分の記録だけを取り消した。
  // 端末 B の記録は打ち消されず、それを根拠として済みに戻る
  checkinRecord({ id: 7, ...ERIN, deviceTime: sec(500) }),
  checkinRecord({ id: 8, ...ERIN, deviceTime: sec(510), deviceId: DEVICE_B }),
  cancelRecord({ id: 9, ...ERIN, deviceTime: sec(600), targets: [7], reasonKind: "wrong_person" }),
  // スナップショットにないチケットの記録。済みのものと、取り消して未のもの
  checkinRecord({ id: 10, ...GONE, deviceTime: sec(700) }),
  checkinRecord({ id: 11, ...GONE_CANCELLED, deviceTime: sec(710) }),
  cancelRecord({ id: 12, ...GONE_CANCELLED, deviceTime: sec(720), targets: [11] }),
  // 前夜祭のチケット。前夜祭受付で済みにした
  checkinRecord({ id: 13, ...CAROL_EVE, deviceTime: sec(800), reception: "eve" }),
];

let environment: TestEnvironment;
let config: ConfigBody;
let outCount = 0;

beforeAll(async () => {
  config = await loadLocalConfig();
  environment = await migratedEnvironment();
}, TIMEOUT);
afterAll(() => environment.cleanup());

const newOut = (): string => join(environment.dir, "out", `export-${outCount++}`);

async function run(options: Partial<ExportOptions> = {}, hooks: ExportDeps["hooks"] = {}): Promise<string> {
  const out = options.out ?? newOut();
  await exportRecords(environment.target, { ...options, out }, { now: () => NOW, release: "test-release", log: silent, hooks });
  return out;
}

async function readOut(out: string): Promise<Record<string, string>> {
  const names = (await readdir(out)).sort();
  return Object.fromEntries(await Promise.all(names.map(async (name) => [name, await readFile(join(out, name), "utf8")] as const)));
}

const rowsOf = (csv: string | undefined): Record<string, string>[] => parse(csv ?? "", { columns: true });

describe("export", () => {
  it(
    "まだ公開していなければ止まる",
    async () => {
      const out = newOut();
      await expect(run({ out })).rejects.toThrow(/まだ公開していません/);
      await expect(readdir(out)).rejects.toThrow();
    },
    TIMEOUT,
  );

  it(
    "書き出しの各ファイルが、ゴールデンファイルと一致する",
    async () => {
      await importSynthetic(environment, config, "main", T + 1);
      await importSynthetic(environment, config, "eve", T + 2);
      await importSynthetic(environment, config, "party", T + 3);
      await publish(environment.target, config, { now: () => T + 10, log: silent, warn: silent });
      await insertRecords(environment.target, RECORDS);
      await insertDevices(environment.target, [
        { deviceId: DEVICE_A, clockOffsetMs: 1200, measuredAt: sec(1000), maxAbsOffsetMs: 1500, maxMeasuredAt: sec(500), appVersion: "v1.2.0" },
        // 最大の差が 5 分を超える。最新の差は小さい（ずれたまま受付をした後に、時計が直った端末）
        { deviceId: DEVICE_B, clockOffsetMs: -900, measuredAt: sec(900), maxAbsOffsetMs: 400_000, maxMeasuredAt: sec(300), appVersion: "v1.1.0-3-g54bfc78" },
      ]);

      const files = await readOut(await run());
      expect(Object.keys(files)).toEqual([
        "bulk-checkin-1.csv",
        "cancelled.csv",
        "clock-drift.csv",
        "devices.csv",
        "done-with-cancel.csv",
        "fortee-only.csv",
        "manifest.json",
        "missing-from-snapshot.csv",
        "records.json",
      ]);
      for (const [name, content] of Object.entries(files)) {
        // 世代は、マイグレーションが付ける乱数なので、置き換えてから比べる
        const generation = JSON.parse(files["manifest.json"] ?? "{}").generation as string;
        expect(generation).toMatch(/^[0-9a-f]{32}$/);
        await expect(content.replaceAll(generation, "<世代>")).toMatchFileSnapshot(join(GOLDEN, name));
      }
    },
    TIMEOUT,
  );

  it(
    "一括チェックイン CSV は、済みで、スナップショットにあるチケットを、根拠の記録の端末時刻で 1 行ずつ出す",
    async () => {
      const files = await readOut(await run());
      expect(files["bulk-checkin-1.csv"]).toBe(
        [
          "profile_url_token,checkined_at",
          `${profileUrlTokenOf(MAIN, "A-1")},2026-11-28T09:30:00+09:00`,
          // 再チェックインの記録が根拠になる
          `${profileUrlTokenOf(MAIN, "A-6")},2026-11-28T09:36:40+09:00`,
          // 打ち消されなかった、端末 B の記録が根拠になる
          `${profileUrlTokenOf(MAIN, "Z-1")},2026-11-28T09:38:30+09:00`,
          `${profileUrlTokenOf(EVE, "M-2")},2026-11-28T09:43:20+09:00`,
          "",
        ].join("\n"),
      );
      // スナップショットにない参加者（A-99）は、済みでも CSV に含めない。チケットトークンは書かない
      expect(files["bulk-checkin-1.csv"]).not.toContain(GONE.ticketToken);
      expect(files["bulk-checkin-1.csv"]).not.toContain(ALICE.ticketToken);

      // cancelled.csv: イベントとチケットトークンを出し、スナップショットにないチケットでは、イベントの列が空になる
      expect(rowsOf(files["cancelled.csv"])).toMatchObject([
        { event: "main", ticket_token: CAROL.ticketToken, ticket_no: "A-5", user_name: "test-carol", cancelled_reason_kind: "誤操作", cancelled_reception: "main", cancelled_reception_name: "本編受付" },
        { event: "", ticket_token: GONE_CANCELLED.ticketToken, ticket_no: "A-98", user_name: 'test-gone, "引用符"' },
      ]);

      // done-with-cancel.csv: 取り消した後に再チェックインしたチケットと、重複のチェックインで済みに戻ったチケットの両方を出す
      expect(rowsOf(files["done-with-cancel.csv"])).toMatchObject([
        {
          ticket_no: "A-6",
          done_route: "検索",
          last_cancel_reception: "",
          last_cancel_reception_name: "受付なし",
          last_cancel_reason_kind: "その他",
          last_cancel_reason_text: REASON_TEXT,
          last_cancel_operator_name: "受付 \"二郎\"; '",
          basis_before_last_cancel: "false",
        },
        { ticket_no: "Z-1", done_route: "QR", last_cancel_reason_kind: "別人だった", last_cancel_reason_text: "", basis_before_last_cancel: "true" },
      ]);

      expect(rowsOf(files["missing-from-snapshot.csv"])).toEqual([
        { ticket_token: GONE_CANCELLED.ticketToken, ticket_no: "A-98", user_name: 'test-gone, "引用符"', record_count: "2" },
        { ticket_token: GONE.ticketToken, ticket_no: "A-99", user_name: "test-gone", record_count: "1" },
      ]);
      // fortee 側でだけ済み
      expect(rowsOf(files["fortee-only.csv"])).toMatchObject([{ event: "main", ticket_no: "A-4", user_name: "test-bob" }]);
      // 時計のずれは、最大の差で判定する
      expect(rowsOf(files["clock-drift.csv"])).toMatchObject([{ device_id: DEVICE_B, device_name: "端末 3AFL", max_abs_offset_ms: "400000" }]);
      expect(rowsOf(files["devices.csv"]).map((row) => row.app_version)).toEqual(["v1.1.0-3-g54bfc78", "v1.2.0"]);

      // records.json は、読んだ全記録を、すべての項目と seq、receivedAt とともに持つ
      const dump = parseRecordsDump(files["records.json"] ?? "", "records.json");
      expect(dump).toMatchObject({ format: 0, environment: "local", maxSeq: 13 });
      expect(dump.records).toEqual(RECORDS);
      expect(JSON.parse(files["manifest.json"] ?? "")).toMatchObject({
        environment: "local",
        slug: "yapc-tokyo-2026-sandbox",
        release: "test-release",
        startedAt: NOW,
        generation: dump.generation,
        configVersion: T + 10,
        maxSeq: 13,
        recordCount: 13,
        devicesReadAt: NOW,
        chunk: null,
        driftThresholdMinutes: 5,
      });
    },
    TIMEOUT,
  );

  it(
    "--chunk の行数で、一括チェックイン CSV を分割する。--drift-threshold で、時計のずれの閾値を変える",
    async () => {
      const files = await readOut(await run({ chunk: 3, driftThresholdMinutes: 7 }));
      expect(Object.keys(files).filter((name) => name.startsWith("bulk-checkin-"))).toEqual(["bulk-checkin-1.csv", "bulk-checkin-2.csv"]);
      expect(rowsOf(files["bulk-checkin-1.csv"])).toHaveLength(3);
      expect(rowsOf(files["bulk-checkin-2.csv"])).toEqual([{ profile_url_token: profileUrlTokenOf(EVE, "M-2"), checkined_at: "2026-11-28T09:43:20+09:00" }]);
      expect(rowsOf(files["clock-drift.csv"])).toEqual([]);
      expect(JSON.parse(files["manifest.json"] ?? "")).toMatchObject({ chunk: 3, driftThresholdMinutes: 7 });
    },
    TIMEOUT,
  );

  it(
    "--out がすでにあると、空のディレクトリでも止まる",
    async () => {
      const out = newOut();
      await mkdir(out, { recursive: true });
      await expect(run({ out })).rejects.toThrow(/すでにあります/);
      expect(await readdir(out)).toEqual([]);
    },
    TIMEOUT,
  );

  it(
    "途中で止めると、--out はできない。一時ディレクトリが残る",
    async () => {
      const out = newOut();
      await expect(
        run({ out }, {
          beforeRename: async () => {
            throw new Error("止めた");
          },
        }),
      ).rejects.toThrow("止めた");
      const siblings = await readdir(join(environment.dir, "out"));
      expect(siblings).not.toContain(out.split("/").at(-1));
      const temporary = siblings.filter((name) => name.includes(".tmp-"));
      expect(temporary).toHaveLength(1);
      expect(await readdir(join(environment.dir, "out", temporary[0] ?? ""))).toContain("manifest.json");
    },
    TIMEOUT,
  );

  it(
    "読んでいる間に記録を足しても、出力は変わらない",
    async () => {
      const before = await readOut(await run());
      const after = await readOut(
        await run({}, {
          // 範囲を固定した後に、同期で記録が増える
          afterFix: () => insertRecords(environment.target, [checkinRecord({ id: 14, ...FRANK, deviceTime: sec(900) })]),
        }),
      );
      expect(after).toEqual(before);
      // 次の書き出しには、足した記録が入る
      const next = await readOut(await run());
      expect(JSON.parse(next["manifest.json"] ?? "")).toMatchObject({ maxSeq: 14, recordCount: 14 });
      expect(rowsOf(next["bulk-checkin-1.csv"])).toHaveLength(5);
    },
    TIMEOUT,
  );

  it(
    "同期データ由来の数式を確認用 CSV では文字列にし、fortee 用 CSV と記録ダンプは変えない",
    async () => {
      const before = await readOut(await run());
      await insertDevices(environment.target, [
        { deviceId: "cccccccccccccccccccccccccccccccc", clockOffsetMs: 0, measuredAt: sec(1200), maxAbsOffsetMs: 0, maxMeasuredAt: sec(1200), appVersion: "=1+1" },
      ]);
      const after = await readOut(await run());
      expect(rowsOf(after["devices.csv"]).find((row) => row.app_version === "\t=1+1")).toBeDefined();
      expect(after["devices.csv"]).toContain('"\t=1+1"');
      expect(after["bulk-checkin-1.csv"]).toBe(before["bulk-checkin-1.csv"]);
      expect(after["records.json"]).toBe(before["records.json"]);
    },
    TIMEOUT,
  );

  it(
    "書き出しの間に世代が変わると、何も書かずに止まる",
    async () => {
      const out = newOut();
      const before = await readdir(join(environment.dir, "out"));
      await expect(run({ out }, { beforeRecheck: () => bumpGeneration(environment.target, silent) })).rejects.toThrow(/世代が書き換えられました/);
      expect(await readdir(join(environment.dir, "out"))).toEqual(before);
    },
    TIMEOUT,
  );

  it(
    "控えた版のキーが KV から消えていれば止まる（書き出しの間に、公開が 2 回あった）",
    async () => {
      await kvDelete(environment.target, `config:${T + 10}`);
      const out = newOut();
      await expect(run({ out })).rejects.toThrow(new RegExp(`KV に config:${T + 10} がありません。.*export をやり直してください`));
      await expect(readdir(out)).rejects.toThrow();
    },
    TIMEOUT,
  );
});
