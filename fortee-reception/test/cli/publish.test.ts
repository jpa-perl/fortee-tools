import { readFile } from "node:fs/promises";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { ConfigBody } from "../../src/core/config-file.ts";
import { toPublishedConfig } from "../../src/core/config-file.ts";
import { importZip } from "../../src/cli/commands/import.ts";
import { publish, readVersionsText } from "../../src/cli/commands/publish.ts";
import { textParam } from "../../src/cli/sql.ts";
import type { Target } from "../../src/cli/target.ts";
import { snapshotPath } from "../../src/cli/workdir.ts";
import { d1Execute, kvGet, kvList, kvPut } from "../../src/cli/wrangler.ts";
import {
  cloneEnvironment,
  configVariant,
  importSynthetic,
  loadLocalConfig,
  migratedEnvironment,
  silent,
  type TestEnvironment,
  TIMEOUT,
  writeZip,
} from "./helpers.ts";
import { SYNTHETIC_EVENT_IDS, SYNTHETIC_EVENTS, syntheticZipParts } from "./synthetic-zip.ts";

// 公開（Design Doc 8.4、9.4、FR-44）。wrangler を実際に呼び、ローカルの D1 と KV（一時ディレクトリ）で確かめる。
// スナップショットは、合成の ZIP（synthetic-zip.ts。Sandbox の本物の ZIP ではない）から取り込んだものである。

const { main: MAIN, eve: EVE, party: PARTY } = SYNTHETIC_EVENT_IDS;
// 取り込みと公開の時刻。版になる
const T = 1_794_000_000_000;

let template: TestEnvironment;
let config: ConfigBody;
let environment: TestEnvironment;

beforeAll(async () => {
  config = await loadLocalConfig();
  template = await migratedEnvironment();
}, TIMEOUT);
afterAll(() => template.cleanup());
afterEach(() => environment?.cleanup());

/** マイグレーション済みで、3 つのイベントを取り込んだ環境。版は、本編 T+1、前夜祭 T+2、懇親会 T+3 */
async function importedEnvironment(): Promise<TestEnvironment> {
  environment = await cloneEnvironment(template);
  await importSynthetic(environment, config, "main", T + 1);
  await importSynthetic(environment, config, "eve", T + 2);
  await importSynthetic(environment, config, "party", T + 3);
  return environment;
}

const run = (target: Target, now: number, options: { config?: ConfigBody; beforeSwitch?: () => Promise<void>; warn?: (line: string) => void } = {}) =>
  publish(target, options.config ?? config, {
    now: () => now,
    log: silent,
    warn: options.warn ?? silent,
    hooks: options.beforeSwitch === undefined ? {} : { beforeSwitch: options.beforeSwitch },
  });

const storedKeys = async (target: Target): Promise<string[]> => [...(await kvList(target, "config:")), ...(await kvList(target, "snapshot:"))].sort();

const versionsOf = async (target: Target): Promise<unknown> => JSON.parse((await readVersionsText(target)) ?? "null");

describe("publish: 公開と掃除（Design Doc 8.4）", () => {
  it(
    "KV に設定とスナップショットを書き、D1 の版を切り替える。値は、引用符、改行、; を含んでもそのまま保存される",
    async () => {
      const { target, dir } = await importedEnvironment();
      // 拒否時のメッセージに、引用符、改行、;、バックスラッシュ、絵文字を含める
      const message = "懇親会チケットが'ありません\"; DROP TABLE meta; --\n改行と\\と🎫";
      const special = await configVariant(dir, "special", (toml) =>
        toml.replace('rejectMessage = "懇親会チケットがありません"', `rejectMessage = ${JSON.stringify(message)}`),
      );
      expect(await readVersionsText(target)).toBeNull();

      await run(target, T + 10, { config: special });

      expect(await versionsOf(target)).toEqual({ config: T + 10, events: { [MAIN]: T + 1, [EVE]: T + 2, [PARTY]: T + 3 } });
      expect(await storedKeys(target)).toEqual(
        [`config:${T + 10}`, `snapshot:${MAIN}:${T + 1}`, `snapshot:${EVE}:${T + 2}`, `snapshot:${PARTY}:${T + 3}`].sort(),
      );

      // 公開した設定を読み戻す。公開の版と形式の版が加わり、値はそのままである
      const stored = await kvGet(target, `config:${T + 10}`);
      expect(stored).toBe(JSON.stringify(toPublishedConfig(special, T + 10)));
      expect(JSON.parse(stored ?? "").receptions[2].rejectMessage).toBe(message);

      // スナップショットは、作業ディレクトリのファイルと 1 バイトも違わない（日本語、引用符、改行を含む）
      for (const eventId of [MAIN, EVE, PARTY]) {
        const local = await readFile(snapshotPath(target, eventId), "utf8");
        const version = JSON.parse(local).version as number;
        expect(await kvGet(target, `snapshot:${eventId}:${version}`)).toBe(local);
      }
      // 環境の印には触れない
      expect(await kvGet(target, "environment")).toBe("local");
    },
    TIMEOUT,
  );

  it(
    "掃除は、新しい版と、公開を始めたときの版だけを残す。途中で失敗した公開が書き残したキーも消す",
    async () => {
      const { target } = await importedEnvironment();
      await run(target, T + 10);

      // 本編だけを取り込み直して、公開し直す。どの版からも指されないキー（失敗した公開の書き残し）も置いておく
      await importSynthetic(environment, config, "main", T + 20);
      await kvPut(target, `config:${T + 15}`, "{}");
      await kvPut(target, `snapshot:${MAIN}:${T + 15}`, "{}");
      await run(target, T + 30);
      expect(await versionsOf(target)).toEqual({ config: T + 30, events: { [MAIN]: T + 20, [EVE]: T + 2, [PARTY]: T + 3 } });
      // 現在と 1 つ前の版が残る。新しい版を取得している端末が、取得の途中で次の公開に出会っても失敗しないようにするためである
      expect(await storedKeys(target)).toEqual(
        [
          `config:${T + 10}`,
          `config:${T + 30}`,
          `snapshot:${MAIN}:${T + 1}`,
          `snapshot:${MAIN}:${T + 20}`,
          `snapshot:${EVE}:${T + 2}`,
          `snapshot:${PARTY}:${T + 3}`,
        ].sort(),
      );

      // もう一度公開すると、2 つ前の版のキーが消える
      await run(target, T + 40);
      expect(await storedKeys(target)).toEqual(
        [`config:${T + 30}`, `config:${T + 40}`, `snapshot:${MAIN}:${T + 20}`, `snapshot:${EVE}:${T + 2}`, `snapshot:${PARTY}:${T + 3}`].sort(),
      );
      expect(await kvGet(target, "environment")).toBe("local");
    },
    TIMEOUT,
  );

  it(
    "設定から外したイベントは、版に含めない",
    async () => {
      const { target, dir } = await importedEnvironment();
      await run(target, T + 10);
      const withoutParty = await configVariant(dir, "without-party", (toml) =>
        toml.replace(/\[\[events\]\]\nid = "00000000-0000-4000-8000-000000000003"[\s\S]*?\n\n/, "").replace(/\[\[receptions\]\]\nid = "party"[\s\S]*?\n\n/, "").replace(/\{\{#byEvent\.party\}\}[\s\S]*\{\{\/byEvent\.party\}\}\n/, ""),
      );
      await run(target, T + 20, { config: withoutParty });
      expect(await versionsOf(target)).toEqual({ config: T + 20, events: { [MAIN]: T + 1, [EVE]: T + 2 } });
    },
    TIMEOUT,
  );
});

describe("publish: 競合の検出（Design Doc 8.4 の 8、8.8）", () => {
  it(
    "版を読んでから書くまでのあいだに、ほかの公開が版を書き換えると、競合で止まり、掃除をしない",
    async () => {
      const { target } = await importedEnvironment();
      await run(target, T + 10);
      await importSynthetic(environment, config, "main", T + 20);

      const others = JSON.stringify({ config: T + 25, events: { [MAIN]: T + 1, [EVE]: T + 2, [PARTY]: T + 3 } });
      await expect(
        run(target, T + 30, {
          beforeSwitch: async () => {
            await d1Execute(target, `UPDATE meta SET value = ${textParam(others)} WHERE key = 'versions'`);
          },
        }),
      ).rejects.toThrow(/公開の競合です/);

      // ほかの公開が書いた版を、上書きしていない
      expect(await readVersionsText(target)).toBe(others);
      // 掃除をしていない。前の版のキーも、この公開が書いたキーも残っている
      const keys = await storedKeys(target);
      expect(keys).toContain(`config:${T + 10}`);
      expect(keys).toContain(`snapshot:${MAIN}:${T + 1}`);
      expect(keys).toContain(`config:${T + 30}`);
      expect(keys).toContain(`snapshot:${MAIN}:${T + 20}`);
    },
    TIMEOUT,
  );

  it(
    "まだ公開の版がないときも、ほかの公開が先に入れた行を書き換えない",
    async () => {
      const { target } = await importedEnvironment();
      const others = JSON.stringify({ config: T + 5, events: {} });
      await expect(
        run(target, T + 10, {
          beforeSwitch: async () => {
            await d1Execute(target, `INSERT INTO meta (key, value) VALUES ('versions', ${textParam(others)})`);
          },
        }),
      ).rejects.toThrow(/公開の競合です/);
      expect(await readVersionsText(target)).toBe(others);
    },
    TIMEOUT,
  );
});

describe("publish: 公開の前に止まる条件（Design Doc 8.4 の 4〜6、9.4）", () => {
  it(
    "スナップショットのないイベント、設定と一致しない列、公開中の版より古い版、重複するトークンで止まる。種別名は警告にとどめる",
    async () => {
      const { target, dir } = await importedEnvironment();
      const published = async () => (await readVersionsText(target)) !== null;

      // 設定で参照しない列を、スナップショットが持っている。外した項目の回答を、端末に残さない
      const fewer = await configVariant(dir, "fewer", (toml) =>
        toml.replace('[[display.answers]]\nevent = "main"\nfield = "懇親会参加"\nkey = "party"\n', "").replace(/\{\{#answers\.party\}\}[\s\S]*?\{\{\/answers\.party\}\}\n/, ""),
      );
      await expect(run(target, T + 10, { config: fewer })).rejects.toThrow(
        /テスト本編（main）: 設定で参照しない列をスナップショットが持っています: 「懇親会参加」/,
      );

      // 設定で参照する列が、スナップショットにない。警告にして通すことはしない
      const more = await configVariant(dir, "more", (toml) => toml.replace("[[display.answers]]", '[[search.answers]]\nevent = "eve"\nfield = "お名前"\n\n[[display.answers]]'));
      await expect(run(target, T + 10, { config: more })).rejects.toThrow(
        /テスト前夜祭（eve）: 設定で参照する列がスナップショットにありません: 「お名前」/,
      );
      expect(await published()).toBe(false);

      // 種別名の食い違いは、両方の向きを警告に出して、公開は通す
      const types = await configVariant(dir, "types", (toml) =>
        toml.replace('types = ["テスト本編スタッフチケット"]', 'types = ["テスト本編学生チケット"]'),
      );
      const warnings: string[] = [];
      await run(target, T + 10, { config: types, warn: (line) => warnings.push(line) });
      expect(warnings).toEqual([
        expect.stringMatching(/display\.ticketTypes（key "staff"）の種別「テスト本編学生チケット」は、スナップショットのどのチケットの種別とも一致しません/),
        expect.stringMatching(/スナップショットにある種別「テスト本編スタッフチケット」は、display\.ticketTypes のどのエントリにも含まれません/),
      ]);
      const before = await readVersionsText(target);

      // 作業ディレクトリの版が、公開中の版より古い。別の端末や、以前の取り込みが残った作業ディレクトリからの公開
      await importSynthetic(environment, config, "main", T - 100);
      await expect(run(target, T + 20)).rejects.toThrow(
        new RegExp(`公開中の版より古いイベントがあります\\n {2}テスト本編（main）: 作業ディレクトリの版 ${T - 100}（.*）、公開中の版 ${T + 1}（`),
      );
      expect(await readVersionsText(target)).toBe(before);
      // そのイベントを取り込み直すと通る
      await importSynthetic(environment, config, "main", T + 30);
      await run(target, T + 40);
      expect(await versionsOf(target)).toMatchObject({ config: T + 40, events: { [MAIN]: T + 30 } });
      const after = await readVersionsText(target);

      // 同じ ZIP を 2 つのイベントに取り込んだ。チケットトークンと profile_url_token が、イベントのあいだで重複する
      const zip = await writeZip(dir, "main-as-eve", syntheticZipParts(SYNTHETIC_EVENTS.main));
      await importZip(target, config, { event: "eve", zip }, { now: () => T + 50, log: silent, warn: silent });
      const duplicated = await run(target, T + 60).catch((error: Error) => error.message);
      expect(duplicated).toMatch(/チケットトークンが、スナップショットのあいだで重複しています\n {2}テスト本編（main） と テスト前夜祭（eve）: 7 件/);
      // 重複の文言に、トークンを出さない
      expect(duplicated).not.toMatch(/[0-9A-Za-z]{32}/);
      expect(await readVersionsText(target)).toBe(after);
    },
    TIMEOUT,
  );

  it(
    "作業ディレクトリに、スナップショットのないイベントがあれば止まる",
    async () => {
      environment = await cloneEnvironment(template);
      await importSynthetic(environment, config, "main", T + 1);
      await expect(run(environment.target, T + 10)).rejects.toThrow(/スナップショットのないイベントがあります: テスト前夜祭（eve）、テスト懇親会（party）/);
      expect(await readVersionsText(environment.target)).toBeNull();
      expect(await storedKeys(environment.target)).toEqual([]);
    },
    TIMEOUT,
  );
});
