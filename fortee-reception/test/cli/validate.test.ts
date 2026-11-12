import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { configureJapaneseMessages } from "../../src/core/messages.ts";
import { validate } from "../../src/cli/commands/validate.ts";
import { loadConfigFile, readConfigFile } from "../../src/cli/config-file.ts";
import type { Target } from "../../src/cli/target.ts";
import { LOCAL_CONFIG_PATH } from "./helpers.ts";

// 設定検証（Design Doc 4.2 の検証の表、8.7、FR-4）。誤りの種類ごとの TOML を並べる。
// 検証の規則そのものの網羅は、core のテスト（test/core/config-file.test.ts）にある。
// ここでは、TOML から読んで、誤りがすべて列挙されるところまでを確かめる。

let dir: string;
let local: string;
let count = 0;

beforeAll(async () => {
  configureJapaneseMessages();
  dir = await mkdtemp(join(tmpdir(), "checkin-cli-validate-"));
  local = await readFile(LOCAL_CONFIG_PATH, "utf8");
});
afterAll(() => rm(dir, { recursive: true, force: true }));

/** config/local.toml を書き換えた設定ファイルを作る */
async function variant(change: (toml: string) => string): Promise<string> {
  const changed = change(local);
  if (changed === local) throw new Error("書き換えが当たっていない");
  const path = join(dir, `config-${count++}.toml`);
  await writeFile(path, changed);
  return path;
}

const targetOf = (configPath: string, env = "local"): Target => ({ env, local: env === "local", configPath, workDir: "" });

async function errorsOf(change: (toml: string) => string, env = "local"): Promise<string[]> {
  const loaded = await loadConfigFile(await variant(change), env);
  return loaded.ok ? [] : loaded.errors.map((error) => `${error.path}: ${error.message}`);
}

describe("validate（Design Doc 8.7）", () => {
  it("ローカルの開発の設定（config/local.toml）は、検証を通る", async () => {
    const lines: string[] = [];
    await validate(targetOf(LOCAL_CONFIG_PATH), (line) => lines.push(line));
    expect(lines[0]).toContain("誤りはありません");
    expect(lines.join("\n")).toContain("イベント: 3 個、受付: 3 個（期間 3 個）");
  });

  it("期間のローカル日時を、設定のタイムゾーンで解釈する。イベントの参照は id に解決する", async () => {
    const config = await readConfigFile(LOCAL_CONFIG_PATH, "local");
    const main = config.receptions.find((reception) => reception.id === "main");
    // Asia/Tokyo の 2026-01-01T00:00:00 は、UTC の 2025-12-31T15:00:00
    expect(main?.periods).toEqual([{ start: Date.UTC(2025, 11, 31, 15), end: Date.UTC(2029, 11, 31, 15) }]);
    expect(main?.accept).toEqual(["00000000-0000-4000-8000-000000000001"]);
    expect(config.search.columns).toEqual(["ticketNo", "userName", "name"]);
  });

  it("誤りをすべて列挙してから、止まる", async () => {
    const path = await variant((toml) =>
      toml
        .replace('timezone = "Asia/Tokyo"', 'timezone = "Asia/Edo"')
        .replace('checkin = ["party"]', 'checkin = ["main"]')
        .replace("{{user.userName}}", "{{user.userNmae}}"),
    );
    const failure = await validate(targetOf(path, "yapc-tokyo-2026"), () => {}).catch((error: Error) => error.message);
    expect(failure).toContain("に誤りがあります（4 件）");
    expect(failure).toContain("conference.environment: ");
    expect(failure).toContain("conference.timezone: ");
    expect(failure).toContain("receptions[2].checkin[0]: ");
    expect(failure).toContain("template.reference: ");
  });

  it("読めないファイルと、TOML として解析できないファイルで止まる", async () => {
    await expect(validate(targetOf(join(dir, "none.toml")), () => {})).rejects.toThrow(/を読めません/);
    const path = join(dir, "broken.toml");
    await writeFile(path, "[conference\n");
    await expect(validate(targetOf(path), () => {})).rejects.toThrow(/TOML として解析できません/);
  });
});

describe("設定検証: 誤りの種類ごとの TOML（Design Doc 4.2 の検証の表）", () => {
  const cases: [name: string, change: (toml: string) => string, expected: RegExp][] = [
    ["イベントの id が重複する", (t) => t.replace("000000000002", "000000000001"), /^events\[1\]\.id: .*重複/],
    ["イベントの key が重複する", (t) => t.replace('key = "eve"\n', 'key = "main"\n'), /^events\[1\]\.key: .*重複/],
    ["イベントの key の形", (t) => t.replace('key = "eve"\n', 'key = "eve party"\n'), /^events\[1\]\.key: .*英数字/],
    ["イベントの id の形", (t) => t.replace("00000000-0000-4000-8000-000000000002", "eve:1"), /^events\[1\]\.id: .*英数字/],
    ["受付の id が重複する", (t) => t.replace('id = "party"', 'id = "main"'), /^receptions\[2\]\.id: .*重複/],
    ["受付の id の形", (t) => t.replace('id = "party"', 'id = "懇親会"'), /^receptions\[2\]\.id: .*英数字/],
    ["search.columns の値", (t) => t.replace("[search]\n", '[search]\ncolumns = ["ticketNo", "email"]\n'), /^search\.columns\[1\]: "email"/],
    ["受付が、存在しないイベントを指す", (t) => t.replace('require = ["party"]', 'require = ["nursery"]'), /^receptions\[2\]\.require\[0\]: "nursery" は events の key でも id でもありません/],
    ["アンケートの項目が、存在しないイベントを指す", (t) => t.replace('event = "main"\nfield = "所属"', 'event = "nursery"\nfield = "所属"'), /^display\.answers\[0\]\.event: /],
    ["checkin が accept に含まれない", (t) => t.replace('accept = ["main"]', 'accept = ["eve"]'), /^receptions\[1\]\.checkin\[0\]: .*accept に含まれていません/],
    ["期間が重複する", (t) => t.replace("start = 2030-01-01T00:00:00", "start = 2029-12-31T23:59:59"), /^receptions\[2\]\.periods\[0\]: .*重複/],
    ["start が end より前でない", (t) => t.replace("end = 2030-01-02T00:00:00", "end = 2030-01-01T00:00:00"), /^receptions\[2\]\.periods\[0\]: start/],
    ["期間がオフセット付きの日時", (t) => t.replace("start = 2030-01-01T00:00:00", "start = 2030-01-01T00:00:00+09:00"), /^receptions\[2\]\.periods\[0\]\.start: .*ローカル日時/],
    ["期間が日付だけ", (t) => t.replace("start = 2030-01-01T00:00:00", "start = 2030-01-01"), /^receptions\[2\]\.periods\[0\]\.start: .*ローカル日時/],
    ["期間が文字列", (t) => t.replace("start = 2030-01-01T00:00:00", 'start = "2030-01-01 00:00"'), /^receptions\[2\]\.periods\[0\]\.start: .*ローカル日時/],
    ["timezone が解釈できない", (t) => t.replace('timezone = "Asia/Tokyo"', 'timezone = "JST+9"'), /^conference\.timezone: /],
    ["テンプレートの構文の誤り", (t) => t.replace("{{/byEvent.party}}", ""), /^template\.reference: .*解析できません/],
    ["テンプレートに、持たないタグがある", (t) => t.replace("{{user.userName}}", "{{{user.userName}}}"), /^template\.reference: 1 行目: エスケープしない変数/],
    ["テンプレートの名前が、文脈にない", (t) => t.replace("{{answers.party}}", "{{answers.tshirt}}"), /^template\.reference: \d+ 行目: /],
    ["display.answers の key が、同じイベントの中で重複する", (t) => t.replace('key = "party"\n\n[[display.ticketTypes]]', 'key = "affiliation"\n\n[[display.ticketTypes]]'), /^display\.answers\[1\]\.key: .*重複/],
    ["display.ticketTypes の key が、同じイベントの中で重複する", (t) => t.replace('key = "staff"', 'key = "general"'), /^display\.ticketTypes\[1\]\.key: .*重複/],
    ["display.ticketTypes の types が空", (t) => t.replace('types = ["テスト本編スタッフチケット"]', "types = []"), /^display\.ticketTypes\[1\]\.types: /],
    ["key に「.」を含む", (t) => t.replace('key = "affiliation"', 'key = "a.b"'), /^display\.answers\[0\]\.key: /],
    ["知らない項目", (t) => t.replace('rejectMessage = "懇親会チケットがありません"', 'rejectMesage = "懇親会チケットがありません"'), /^receptions\[2\]/],
    ["必須の項目がない", (t) => t.replace(/\[template\][\s\S]*$/, ""), /^template: /],
  ];

  it.each(cases)("%s", async (_name, change, expected) => {
    const errors = await errorsOf(change);
    expect(errors.some((error) => expected.test(error)), errors.join("\n")).toBe(true);
    expect(errors.join("\n")).not.toContain("Invalid input");
  });

  it("conference.environment が --env と一致しない", async () => {
    const loaded = await loadConfigFile(LOCAL_CONFIG_PATH, "yapc-tokyo-2026");
    expect(!loaded.ok && loaded.errors).toEqual([{ path: "conference.environment", message: '"local" が --env（"yapc-tokyo-2026"）と一致しません' }]);
  });
});
