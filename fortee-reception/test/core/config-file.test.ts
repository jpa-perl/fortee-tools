import { parse, TomlDate } from "smol-toml";
import { describe, expect, it } from "vitest";
import { publishedConfigSchema, resolveEventRef } from "../../src/core/config.ts";
import { type ConfigError, toPublishedConfig, validateConfigFile } from "../../src/core/config-file.ts";
import { configureJapaneseMessages } from "../../src/core/messages.ts";
import { DISTRIBUTION_FORMAT } from "../../src/core/versions.ts";
import { EVE, jst, MAIN, NURSERY, PARTY } from "./helpers.ts";

// 設定ファイル（TOML を解析し、ローカル日時を文字列にした値）。Design Doc 4.2 の例による
const valid = () => ({
  conference: {
    slug: "yapc-tokyo-2026",
    name: "YAPC::Tokyo 2026",
    timezone: "Asia/Tokyo",
    environment: "yapc-tokyo-2026",
  },
  events: [
    { id: MAIN, name: "本編", key: "main" },
    { id: EVE, name: "前夜祭", key: "eve" },
    { id: PARTY, name: "懇親会", key: "party" },
    { id: NURSERY, name: "託児所" } as { id: string; name: string; key?: string },
  ],
  receptions: [
    {
      id: "eve",
      name: "前夜祭受付",
      periods: [{ start: "2026-11-27T17:30:00.000", end: "2026-11-27T21:00:00.000" }],
      accept: ["eve", "main"],
      require: ["eve"],
      checkin: ["eve", "main"],
      rejectMessage: "前夜祭チケットがありません。本編の受付は明日からです",
    },
    {
      id: "main",
      name: "本編受付",
      periods: [
        { start: "2026-11-28T09:30:00.000", end: "2026-11-28T17:30:00.000" },
        { start: "2026-11-29T09:30:00.000", end: "2026-11-29T18:00:00.000" },
      ],
      // id でも参照できる
      accept: [MAIN],
      require: ["main"],
      checkin: ["main"],
      rejectMessage: "本編チケットがありません",
    },
    {
      id: "party",
      name: "懇親会受付",
      periods: [{ start: "2026-11-28T17:30:00.000", end: "2026-11-28T20:30:00.000" }],
      accept: ["party"],
      require: ["party"],
      checkin: ["party"],
      rejectMessage: "懇親会チケットがありません",
    },
  ],
  search: {
    answers: [{ event: "main", field: "スピーカー名札に記載するお名前" }] as { event: string; field: string; key?: string }[],
  } as { columns?: string[]; answers?: { event: string; field: string; key?: string }[] },
  display: {
    answers: [{ event: "main", field: "Tシャツのサイズ", key: "tshirt" }] as { event: string; field: string; key?: string }[],
    ticketTypes: [
      {
        event: "main",
        types: ["【カンファレンス本編】一般チケット", "【カンファレンス本編】一般チケット（特別請求）"],
        key: "general",
      },
      { event: "main", types: ["【カンファレンス本編】スタッフチケット"], key: "staff" },
    ],
  },
  template: {
    reference:
      "{{user.userName}} さん\n{{#byEvent.main}}\n本編 {{ticketNo}}{{#typeIs.staff}} スタッフ{{/typeIs.staff}} {{answers.tshirt}}\n{{/byEvent.main}}\n",
  },
});

type Raw = ReturnType<typeof valid>;

/** 正しい設定を書き換えて検証し、誤りを返す */
function errorsOf(change: (raw: Raw) => void, options?: { env?: string }): ConfigError[] {
  const raw = valid();
  change(raw);
  const result = validateConfigFile(raw, options);
  return result.ok ? [] : result.errors;
}

const paths = (errors: ConfigError[]) => errors.map((error) => error.path);

describe("設定検証（FR-4、Design Doc 4.2）: 正しい設定", () => {
  it("通り、参照を id に解決し、期間をエポックミリ秒にし、省略された項目を埋める", () => {
    const result = validateConfigFile(valid(), { env: "yapc-tokyo-2026" });
    expect(result).toEqual({
      ok: true,
      config: {
        conference: valid().conference,
        events: valid().events,
        receptions: [
          {
            id: "eve",
            name: "前夜祭受付",
            periods: [{ start: jst(2026, 11, 27, 17, 30), end: jst(2026, 11, 27, 21, 0) }],
            accept: [EVE, MAIN],
            require: [EVE],
            checkin: [EVE, MAIN],
            rejectMessage: "前夜祭チケットがありません。本編の受付は明日からです",
          },
          {
            id: "main",
            name: "本編受付",
            periods: [
              { start: jst(2026, 11, 28, 9, 30), end: jst(2026, 11, 28, 17, 30) },
              { start: jst(2026, 11, 29, 9, 30), end: jst(2026, 11, 29, 18, 0) },
            ],
            accept: [MAIN],
            require: [MAIN],
            checkin: [MAIN],
            rejectMessage: "本編チケットがありません",
          },
          {
            id: "party",
            name: "懇親会受付",
            periods: [{ start: jst(2026, 11, 28, 17, 30), end: jst(2026, 11, 28, 20, 30) }],
            accept: [PARTY],
            require: [PARTY],
            checkin: [PARTY],
            rejectMessage: "懇親会チケットがありません",
          },
        ],
        search: {
          columns: ["ticketNo", "userName", "name"],
          answers: [{ event: MAIN, field: "スピーカー名札に記載するお名前" }],
        },
        display: {
          answers: [{ event: MAIN, field: "Tシャツのサイズ", key: "tshirt" }],
          ticketTypes: [
            {
              event: MAIN,
              types: ["【カンファレンス本編】一般チケット", "【カンファレンス本編】一般チケット（特別請求）"],
              key: "general",
            },
            { event: MAIN, types: ["【カンファレンス本編】スタッフチケット"], key: "staff" },
          ],
        },
        template: valid().template,
      },
    });
  });

  it("公開する設定は、形式の版と公開の版を持ち、公開する設定のスキーマを通る", () => {
    const result = validateConfigFile(valid());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const published = toPublishedConfig(result.config, 1764100000000);
    expect(published.format).toBe(DISTRIBUTION_FORMAT);
    expect(published.version).toBe(1764100000000);
    expect(publishedConfigSchema.parse(published)).toEqual(published);
    // テンプレートの中の参照は変換しない
    expect(published.template.reference).toContain("{{#byEvent.main}}");
  });

  it("省略できる項目（receptions、search、display）を省ける", () => {
    const { conference, events } = valid();
    const result = validateConfigFile({ conference, events, template: { reference: "" } });
    expect(result).toEqual({
      ok: true,
      config: {
        conference,
        events,
        receptions: [],
        search: { columns: ["ticketNo", "userName", "name"], answers: [] },
        display: { answers: [], ticketTypes: [] },
        template: { reference: "" },
      },
    });
  });

  it("search.columns を書けば、既定の値を置き換える", () => {
    const raw = valid();
    raw.search.columns = ["userName"];
    const result = validateConfigFile(raw);
    expect(result.ok && result.config.search.columns).toEqual(["userName"]);
  });

  it("終了と開始が同じ時刻の期間は、重複ではない（FR-3）", () => {
    // 正しい設定の本編受付（〜17:30）と懇親会受付（17:30〜）が、この形である
    expect(errorsOf(() => {})).toEqual([]);
  });

  it("所持が必須のイベントには制約を置かない（FR-2）。accept にないイベントでもよい", () => {
    expect(errorsOf((raw) => (raw.receptions[2]!.require = ["main", "party"]))).toEqual([]);
  });

  it("同じ種別が、複数のエントリに現れることは許す", () => {
    expect(
      errorsOf((raw) => raw.display.ticketTypes.push({ event: "main", types: ["【カンファレンス本編】スタッフチケット"], key: "all" })),
    ).toEqual([]);
  });

  it("同じ key を、別のイベントに付けることは許す", () => {
    expect(
      errorsOf((raw) => {
        raw.display.answers.push({ event: "eve", field: "サイズ", key: "tshirt" });
        raw.display.ticketTypes.push({ event: "eve", types: ["前夜祭スタッフ"], key: "staff" });
      }),
    ).toEqual([]);
  });

  it("同じ項目を、display.answers と search.answers の両方に置ける", () => {
    expect(errorsOf((raw) => raw.search.answers!.push({ event: "main", field: "Tシャツのサイズ", key: "tshirt" }))).toEqual([]);
  });

  it("smol-toml が読んだローカル日時を、toISOString() で文字列にして渡せる", () => {
    // CLI が行う変換の確認。core は smol-toml に依存しないので、変換はここ（呼び出し側）で行う
    const toml = `
[conference]
slug = "yapc-tokyo-2026"
name = "YAPC::Tokyo 2026"
timezone = "Asia/Tokyo"
environment = "yapc-tokyo-2026"

[[events]]
id = "${MAIN}"
name = "本編"
key = "main"

[[receptions]]
id = "main"
name = "本編受付"
periods = [
  { start = 2026-11-28T09:30:00, end = 2026-11-28T17:30:00 },
  { start = 2026-11-29 09:30:00, end = 2026-11-29T18:00:00.5 },
]
accept = ["main"]
require = ["main"]
checkin = ["main"]
rejectMessage = "本編チケットがありません"

[template]
reference = """
{{user.userName}} さん
"""
`;
    const stringify = (value: unknown): unknown => {
      if (value instanceof TomlDate) return value.toISOString();
      if (Array.isArray(value)) return value.map(stringify);
      if (typeof value === "object" && value !== null) {
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, stringify(item)]));
      }
      return value;
    };
    const result = validateConfigFile(stringify(parse(toml)));
    expect(result.ok && result.config.receptions[0]?.periods).toEqual([
      { start: jst(2026, 11, 28, 9, 30), end: jst(2026, 11, 28, 17, 30) },
      { start: jst(2026, 11, 29, 9, 30), end: jst(2026, 11, 29, 18, 0) + 500 },
    ]);

    // オフセット付きの日時と、日付だけの値は、形で止まる
    const offset = stringify(parse(toml.replace("start = 2026-11-28T09:30:00,", "start = 2026-11-28T09:30:00+09:00,")));
    const dateOnly = stringify(parse(toml.replace("start = 2026-11-28T09:30:00,", "start = 2026-11-28,")));
    for (const raw of [offset, dateOnly]) {
      const invalid = validateConfigFile(raw);
      expect(!invalid.ok && invalid.errors).toMatchObject([{ path: "receptions[0].periods[0].start" }]);
    }
  });
});

describe("設定検証: 誤りの種類ごと（Design Doc 4.2 の検証の表）", () => {
  it("イベントの id が重複する", () => {
    const errors = errorsOf((raw) => raw.events.push({ id: MAIN, name: "本編（重複）" }));
    expect(errors).toEqual([{ path: "events[4].id", message: `"${MAIN}" が events[0].id と重複しています` }]);
  });

  it("イベントの key が重複する", () => {
    const errors = errorsOf((raw) => (raw.events[3]!.key = "main"));
    expect(errors).toEqual([{ path: "events[3].key", message: '"main" が events[0].key と重複しています' }]);
  });

  it("イベントの key が、ほかのイベントの id と同じ", () => {
    const errors = errorsOf((raw) => {
      raw.events[0]!.id = "main-id";
      raw.events[3]!.key = "main-id";
      raw.receptions[1]!.accept = ["main"];
    });
    expect(errors).toEqual([{ path: "events[3].key", message: '"main-id" が events[0].id と同じです' }]);
  });

  it("受付の id が重複する", () => {
    const errors = errorsOf((raw) => (raw.receptions[2]!.id = "eve"));
    expect(errors).toEqual([{ path: "receptions[2].id", message: '"eve" が receptions[0].id と重複しています' }]);
  });

  it.each([
    ["空文字", ""],
    ["33 文字", "a".repeat(33)],
    ["使えない文字", "main.event"],
    ["日本語", "本編"],
    ["空白", "main event"],
  ])("イベントの key の形: %s", (_name, key) => {
    expect(paths(errorsOf((raw) => (raw.events[3]!.key = key)))).toEqual(["events[3].key"]);
  });

  it("イベントの key は、英数字、-、_ の 32 文字まで使える", () => {
    expect(errorsOf((raw) => (raw.events[3]!.key = "Aa0_-".padEnd(32, "x")))).toEqual([]);
  });

  it.each([
    ["空文字", ""],
    ["33 文字", "a".repeat(33)],
    ["使えない文字", "eve/2026"],
  ])("受付の id の形: %s", (_name, id) => {
    expect(paths(errorsOf((raw) => (raw.receptions[0]!.id = id)))).toEqual(["receptions[0].id"]);
  });

  it.each([
    ["空文字", ""],
    ["65 文字", "a".repeat(65)],
    ["区切りになる文字（:）", "event:1"],
    ["区切りになる文字（/）", "event/1"],
    ["区切りになる文字（.）", "event.1"],
  ])("イベントの id の形: %s", (_name, id) => {
    const errors = errorsOf((raw) => {
      raw.events[3]!.id = id;
    });
    expect(paths(errors)).toEqual(["events[3].id"]);
  });

  it("search.columns の値が、ticketNo、userName、name のいずれでもない", () => {
    const errors = errorsOf((raw) => (raw.search.columns = ["ticketNo", "ticketType", "Tシャツのサイズ"]));
    expect(paths(errors)).toEqual(["search.columns[1]", "search.columns[2]"]);
    expect(errors[0]?.message).toContain("ticketNo、userName、name");
  });

  it("conference.environment が、--env と一致しない", () => {
    const errors = errorsOf(() => {}, { env: "staging" });
    expect(errors).toEqual([
      { path: "conference.environment", message: '"yapc-tokyo-2026" が --env（"staging"）と一致しません' },
    ]);
    // --env を渡さなければ確かめない
    expect(errorsOf(() => {})).toEqual([]);
  });

  it.each([
    ["受付の accept", (raw: Raw) => (raw.receptions[0]!.accept = ["eve", "main", "workshop"]), ["receptions[0].accept[2]"]],
    ["受付の require", (raw: Raw) => (raw.receptions[0]!.require = ["workshop"]), ["receptions[0].require[0]"]],
    // accept にも含まれないが、存在しない参照の誤りだけを出す
    ["受付の checkin", (raw: Raw) => (raw.receptions[1]!.checkin = ["main", "workshop"]), ["receptions[1].checkin[1]"]],
    ["search.answers の event", (raw: Raw) => (raw.search.answers![0]!.event = "workshop"), ["search.answers[0].event"]],
    ["display.answers の event", (raw: Raw) => (raw.display.answers[0]!.event = "workshop"), ["display.answers[0].event"]],
    ["display.ticketTypes の event", (raw: Raw) => (raw.display.ticketTypes[1]!.event = "workshop"), ["display.ticketTypes[1].event"]],
  ])("存在しないイベントの参照: %s", (_name, change, expected) => {
    const errors = errorsOf(change);
    expect(paths(errors)).toEqual(expected);
    expect(errors[0]?.message).toBe('"workshop" は events の key でも id でもありません');
  });

  it("checkin が accept に含まれない（FR-2）", () => {
    const errors = errorsOf((raw) => (raw.receptions[2]!.checkin = ["party", "main"]));
    expect(paths(errors)).toEqual(["receptions[2].checkin[1]"]);
    expect(errors[0]?.message).toContain("accept に含まれていません");
  });

  it("checkin ⊆ accept は、解決した id で比べる。key と id の書き方が違っても通る", () => {
    expect(
      errorsOf((raw) => {
        raw.receptions[1]!.accept = [MAIN];
        raw.receptions[1]!.checkin = ["main"];
      }),
    ).toEqual([]);
  });

  it("同じイベントを、key と id で 2 回指す", () => {
    const errors = errorsOf((raw) => (raw.receptions[1]!.checkin = ["main", MAIN]));
    expect(paths(errors)).toEqual(["receptions[1].checkin[1]"]);
    expect(errors[0]?.message).toContain("同じイベントを 2 回指しています");
  });

  it("受付に期間がない（FR-2）", () => {
    const errors = errorsOf((raw) => (raw.receptions[2]!.periods = []));
    expect(errors).toEqual([{ path: "receptions[2].periods", message: "期間を 1 つ以上書きます" }]);
  });

  it("期間が重複する（FR-3）", () => {
    // 懇親会受付を、本編受付の終了の 1 秒前に始める
    const errors = errorsOf((raw) => (raw.receptions[2]!.periods[0]!.start = "2026-11-28T17:29:59"));
    expect(errors).toEqual([
      { path: "receptions[2].periods[0]", message: 'receptions[1].periods[0]（受付 "main"）と重複しています' },
    ]);
  });

  it("同じ受付の中の期間どうしも、重複してはならない", () => {
    const errors = errorsOf((raw) => (raw.receptions[1]!.periods[1]!.start = "2026-11-28T12:00:00"));
    expect(paths(errors)).toEqual(["receptions[1].periods[1]", "receptions[2].periods[0]"]);
  });

  it("一方がもう一方を含む期間も、重複である", () => {
    const errors = errorsOf((raw) =>
      raw.receptions[0]!.periods.push({ start: "2026-11-28T10:00:00", end: "2026-11-28T11:00:00" }),
    );
    expect(paths(errors)).toEqual(["receptions[1].periods[0]"]);
  });

  it.each([
    ["start が end より後", "2026-11-27T22:00:00"],
    ["start と end が同じ", "2026-11-27T21:00:00.000"],
  ])("期間の %s", (_name, start) => {
    const errors = errorsOf((raw) => (raw.receptions[0]!.periods[0]!.start = start));
    expect(paths(errors)).toEqual(["receptions[0].periods[0]"]);
    expect(errors[0]?.message).toContain("より前ではありません");
  });

  it.each([
    ["オフセット付きの日時", "2026-11-27T17:30:00+09:00", "ローカル日時"],
    ["日付だけ", "2026-11-27", "ローカル日時"],
    ["暦にない日付", "2026-11-31T17:30:00", "暦にない日時"],
  ])("期間の日時の形: %s", (_name, start, message) => {
    const errors = errorsOf((raw) => (raw.receptions[0]!.periods[0]!.start = start));
    expect(paths(errors)).toEqual(["receptions[0].periods[0].start"]);
    expect(errors[0]?.message).toContain(message);
  });

  it("夏時間の切り替えで存在しない時刻と、2 回ある時刻", () => {
    const errors = errorsOf((raw) => {
      raw.conference.timezone = "America/New_York";
      raw.receptions[0]!.periods = [
        { start: "2026-03-08T02:30:00", end: "2026-03-08T05:00:00" },
        { start: "2026-10-31T23:00:00", end: "2026-11-01T01:30:00" },
      ];
    });
    expect(paths(errors)).toEqual(["receptions[0].periods[0].start", "receptions[0].periods[1].end"]);
    expect(errors[0]?.message).toContain("存在しない時刻");
    expect(errors[1]?.message).toContain("2 回ある時刻");
  });

  it("timezone が IANA のタイムゾーン名として解釈できない", () => {
    const errors = errorsOf((raw) => (raw.conference.timezone = "Asia/Tokio"));
    expect(errors).toEqual([
      { path: "conference.timezone", message: '"Asia/Tokio" は IANA のタイムゾーン名として解釈できません' },
    ]);
  });

  it("timezone が解釈できなくても、期間の日時の形は確かめる", () => {
    const errors = errorsOf((raw) => {
      raw.conference.timezone = "Asia/Tokio";
      raw.receptions[0]!.periods[0]!.end = "21:00";
    });
    expect(paths(errors)).toEqual(["conference.timezone", "receptions[0].periods[0].end"]);
  });

  it.each([
    ["解析できない（対応しないセクション）", "{{#byEvent.main}}{{ticketNo}}", "テンプレートを解析できません"],
    ["部分集合にないタグ", "{{{user.name}}}", "エスケープしない変数"],
    ["部分テンプレート", "{{>header}}", "部分テンプレート"],
    ["オブジェクトを指す変数", "{{user}}", "値ではありません"],
    ["設定にない key", "{{#byEvent.main}}{{answers.tshrit}}{{/byEvent.main}}", "参照できる名前ではありません"],
    ["設定にないイベント", "{{#byEvent.workshop}}x{{/byEvent.workshop}}", "参照できる名前ではありません"],
    ["設定にない種別の群", "{{#tickets}}{{#typeIs.speaker}}x{{/typeIs.speaker}}{{/tickets}}", "参照できる名前ではありません"],
  ])("テンプレート: %s", (_name, template, message) => {
    const errors = errorsOf((raw) => (raw.template.reference = template));
    expect(paths(errors)).toEqual(["template.reference"]);
    expect(errors[0]?.message).toContain(message);
  });

  it("テンプレートの名前の誤りは、行を添えてすべて列挙する", () => {
    const errors = errorsOf((raw) => (raw.template.reference = "{{user.userName}}\n{{user}}\n\n{{constructor}}\n"));
    expect(errors.map((error) => error.message)).toEqual([
      "2 行目: {{user}} は値ではありません。変数のタグは、文字列か真偽値を指す名前に使います",
      "4 行目: {{constructor}} は、テンプレートから参照できる名前ではありません",
    ]);
  });

  it("テンプレートは、key のないイベントを id で引く", () => {
    expect(errorsOf((raw) => (raw.template.reference = `{{#byEvent.${NURSERY}}}{{ticketNo}}{{/byEvent.${NURSERY}}}`))).toEqual([]);
    expect(paths(errorsOf((raw) => (raw.template.reference = `{{#byEvent.${MAIN}}}{{ticketNo}}{{/byEvent.${MAIN}}}`)))).toEqual([
      "template.reference",
    ]);
  });

  it("display.answers の key が、同じイベントの中で重複する", () => {
    const errors = errorsOf((raw) => raw.display.answers.push({ event: MAIN, field: "参加予定日", key: "tshirt" }));
    expect(errors).toEqual([
      { path: "display.answers[1].key", message: '"tshirt" が、同じイベントの display.answers[0] と重複しています' },
    ]);
  });

  it("display.answers の key を省いた項目は、field で重複を見る", () => {
    const errors = errorsOf((raw) => {
      raw.display.answers.push({ event: "main", field: "参加予定日" });
      raw.display.answers.push({ event: "main", field: "別の項目", key: "参加予定日" });
      raw.display.answers.push({ event: "main", field: "参加予定日" });
    });
    expect(paths(errors)).toEqual(["display.answers[2].key", "display.answers[3].field"]);
  });

  it("search.answers の key（省略時は field）が、同じイベントの中で重複する", () => {
    const errors = errorsOf((raw) => raw.search.answers!.push({ event: MAIN, field: "スピーカー名札に記載するお名前" }));
    expect(paths(errors)).toEqual(["search.answers[1].field"]);
  });

  it("display.ticketTypes の key が、同じイベントの中で重複する", () => {
    const errors = errorsOf((raw) => raw.display.ticketTypes.push({ event: MAIN, types: ["学生チケット"], key: "staff" }));
    expect(errors).toEqual([
      { path: "display.ticketTypes[2].key", message: '"staff" が、同じイベントの display.ticketTypes[1] と重複しています' },
    ]);
  });

  it("display.ticketTypes の types が空", () => {
    const errors = errorsOf((raw) => (raw.display.ticketTypes[1]!.types = []));
    expect(errors).toEqual([{ path: "display.ticketTypes[1].types", message: "種別を 1 つ以上書きます" }]);
  });

  it("display.ticketTypes の types が、同じエントリの中で重複する", () => {
    const errors = errorsOf((raw) => raw.display.ticketTypes[0]!.types.push("【カンファレンス本編】一般チケット"));
    expect(paths(errors)).toEqual(["display.ticketTypes[0].types[2]"]);
  });

  it.each([
    ["「.」", "t.shirt"],
    ["空白", "t shirt"],
    ["全角の空白", "t　shirt"],
    ["改行", "t\nshirt"],
  ])("display.answers の key に %s を含む", (_name, key) => {
    const errors = errorsOf((raw) => {
      raw.display.answers[0]!.key = key;
      raw.template.reference = "";
    });
    expect(paths(errors)).toEqual(["display.answers[0].key"]);
  });

  it("display.answers の key を省いた項目の field に、「.」か空白を含む", () => {
    const errors = errorsOf((raw) => raw.display.answers.push({ event: "main", field: "公式サイトに掲載するSNSアカウントのURL（希望者のみ） v2.0" }));
    expect(paths(errors)).toEqual(["display.answers[1].field"]);
    expect(errors[0]?.message).toContain("key を付けます");
  });

  it("空白を含む項目名も、key を付ければ使える。search.answers の項目名には制約がない", () => {
    expect(
      errorsOf((raw) => {
        raw.display.answers.push({ event: "main", field: "T shirt size v2.0", key: "size" });
        raw.search.answers!.push({ event: "main", field: "T shirt size v2.0" });
      }),
    ).toEqual([]);
  });

  it.each([
    ["「.」", "staff.core"],
    ["空白", "core staff"],
  ])("display.ticketTypes の key に %s を含む", (_name, key) => {
    const errors = errorsOf((raw) => {
      raw.display.ticketTypes[1]!.key = key;
      raw.template.reference = "";
    });
    expect(paths(errors)).toEqual(["display.ticketTypes[1].key"]);
  });

  it("誤りをすべて列挙する。ある項目の誤りが、ほかの項目の検証を止めない", () => {
    const errors = errorsOf(
      (raw) => {
        raw.conference.timezone = "Nowhere/City";
        raw.events[3]!.key = "has space";
        raw.events.push({ id: MAIN, name: "重複" });
        raw.receptions[0]!.id = "main";
        raw.receptions[0]!.accept = ["eve"];
        raw.receptions[1]!.require = ["missing"];
        raw.receptions[2]!.periods[0]!.end = "2026-11-28";
        raw.search.columns = ["email"];
        raw.display.ticketTypes[1]!.types = [];
        raw.display.answers.push({ event: "main", field: "a.b" });
        raw.template.reference = "{{user}}";
      },
      { env: "other" },
    );
    expect(paths(errors).sort()).toEqual(
      [
        "conference.environment",
        "conference.timezone",
        "events[3].key",
        "events[4].id",
        "receptions[1].id",
        "receptions[0].checkin[1]",
        "receptions[1].require[0]",
        "receptions[2].periods[0].end",
        "search.columns[0]",
        "display.ticketTypes[1].types",
        "display.answers[1].field",
        "template.reference",
      ].sort(),
    );
  });
});

describe("設定検証: 項目の有無と型", () => {
  it("必須の項目がない、型が違う、知らない項目がある", () => {
    configureJapaneseMessages();
    const result = validateConfigFile({
      conference: { slug: "", name: "YAPC", timezone: "Asia/Tokyo", environment: "local" },
      events: [{ id: MAIN, name: "本編", kye: "main" }],
      receptions: [{ id: "main", name: "本編受付", periods: [{ start: 1764300000000, end: "2026-11-28T17:30:00" }] }],
      serach: {},
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(paths(result.errors).sort()).toEqual(
      [
        "",
        "conference.slug",
        "events[0]",
        "receptions[0].accept",
        "receptions[0].checkin",
        "receptions[0].periods[0].start",
        "receptions[0].rejectMessage",
        "receptions[0].require",
        "template",
      ].sort(),
    );
    // 知らない項目は、名前を挙げる
    expect(result.errors.find((error) => error.path === "")?.message).toContain("serach");
    expect(result.errors.find((error) => error.path === "events[0]")?.message).toContain("kye");
    // 文言は日本語
    expect(result.errors.find((error) => error.path === "conference.slug")?.message).toContain("1文字以上");
  });

  it.each([
    ["null", null],
    ["文字列", "config"],
    ["空のオブジェクト", {}],
  ])("設定の全体が %s", (_name, raw) => {
    expect(validateConfigFile(raw).ok).toBe(false);
  });
});

describe("イベントの参照の解決（Design Doc 4.2）", () => {
  const events = [
    { id: MAIN, name: "本編", key: "main" },
    { id: EVE, name: "前夜祭" },
  ];

  it("key でも id でも、id に解決する", () => {
    expect(resolveEventRef(events, "main")).toBe(MAIN);
    expect(resolveEventRef(events, MAIN)).toBe(MAIN);
    expect(resolveEventRef(events, EVE)).toBe(EVE);
  });

  it("どのイベントも指さなければ null", () => {
    expect(resolveEventRef(events, "eve")).toBeNull();
    expect(resolveEventRef(events, "")).toBeNull();
    expect(resolveEventRef([], "main")).toBeNull();
  });
});
