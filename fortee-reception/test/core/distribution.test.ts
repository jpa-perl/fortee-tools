import { describe, expect, it } from "vitest";
import { publishedConfigSchema } from "../../src/core/config.ts";
import { snapshotSchema } from "../../src/core/snapshot.ts";
import { DISTRIBUTION_FORMAT } from "../../src/core/versions.ts";

// 配布物（公開する設定とスナップショット）の形。値は Design Doc 4.2 と 4.3 の例による

const MAIN = "8b2e79c9-9301-4dca-ac12-7b686a1ec85e";
const EVE = "87e485da-0d45-432b-9943-4a5a3728bb2b";

const config = {
  format: DISTRIBUTION_FORMAT,
  version: 1764100000000,
  conference: {
    slug: "yapc-tokyo-2026",
    name: "YAPC::Tokyo 2026",
    timezone: "Asia/Tokyo",
    environment: "yapc-tokyo-2026",
  },
  events: [
    { id: MAIN, name: "本編", key: "main" },
    { id: EVE, name: "前夜祭" },
  ],
  receptions: [
    {
      id: "eve",
      name: "前夜祭受付",
      periods: [{ start: 1764232200000, end: 1764244800000 }],
      accept: [EVE, MAIN],
      require: [EVE],
      checkin: [EVE, MAIN],
      rejectMessage: "前夜祭チケットがありません。本編の受付は明日からです",
    },
  ],
  search: {
    columns: ["ticketNo", "userName", "name"],
    answers: [{ event: MAIN, field: "スピーカー名札に記載するお名前" }],
  },
  display: {
    answers: [{ event: MAIN, field: "Tシャツのサイズ", key: "tshirt" }],
    ticketTypes: [{ event: MAIN, types: ["【カンファレンス本編】スタッフチケット"], key: "staff" }],
  },
  template: { reference: "{{user.userName}} さん\n" },
};

const snapshot = {
  format: DISTRIBUTION_FORMAT,
  eventId: MAIN,
  version: 1764200000000,
  columns: ["Tシャツのサイズ", "スピーカー名札に記載するお名前"],
  attendees: [
    {
      ticketToken: "aRZAnjQt1sepvZ2OTJLNQZ1MsAI93cAw",
      ticketNo: "A-12",
      ticketType: "【カンファレンス本編】一般チケット",
      userName: "karupanerura",
      name: "",
      profileUrlToken: "p-token",
      forteeCheckedIn: false,
      answers: { "Tシャツのサイズ": "L", "スピーカー名札に記載するお名前": "" },
    },
  ],
};

describe("公開する設定のスキーマ（Design Doc 4.2）", () => {
  it("公開する設定を通す", () => {
    expect(publishedConfigSchema.parse(config)).toEqual(config);
  });

  it("読めない形式の版を拒む（Design Doc 9.5）", () => {
    expect(publishedConfigSchema.safeParse({ ...config, format: DISTRIBUTION_FORMAT + 1 }).success).toBe(false);
  });

  it("期間は数値で持つ（タイムゾーンの解釈は CLI が済ませる）", () => {
    const withLocal = structuredClone(config) as { receptions: { periods: unknown[] }[] };
    withLocal.receptions[0]!.periods = [{ start: "2026-11-27T17:30:00", end: "2026-11-27T21:00:00" }];
    expect(publishedConfigSchema.safeParse(withLocal).success).toBe(false);
  });

  it("受付の id に使えない文字を拒む", () => {
    const bad = structuredClone(config);
    bad.receptions[0]!.id = "前夜祭";
    expect(publishedConfigSchema.safeParse(bad).success).toBe(false);
  });
});

describe("スナップショットのスキーマ（Design Doc 4.3）", () => {
  it("スナップショットを通し、値を変えない", () => {
    const spaced = structuredClone(snapshot);
    spaced.attendees[0]!.userName = " Ｋａｒｕ ";
    expect(snapshotSchema.parse(spaced)).toEqual(spaced);
  });

  it("参加者が 0 人でも columns を持つ", () => {
    expect(snapshotSchema.safeParse({ ...snapshot, attendees: [] }).success).toBe(true);
    const { columns: _columns, ...withoutColumns } = snapshot;
    expect(snapshotSchema.safeParse(withoutColumns).success).toBe(false);
  });

  it("読めない形式の版を拒む（Design Doc 9.5）", () => {
    expect(snapshotSchema.safeParse({ ...snapshot, format: DISTRIBUTION_FORMAT + 1 }).success).toBe(false);
  });
});

describe("イベント ID の形（KV のキーと配布の URL に入る）", () => {
  it.each(["a:b", "a/b", "a b", "", "x".repeat(65)])("区切りになる文字や長すぎる値 %j を拒む", (id) => {
    const bad = structuredClone(config);
    bad.events[0]!.id = id;
    expect(publishedConfigSchema.safeParse(bad).success).toBe(false);
    expect(snapshotSchema.safeParse({ ...snapshot, eventId: id }).success).toBe(false);
  });
});
