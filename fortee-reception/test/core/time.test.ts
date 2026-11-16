import { describe, expect, it } from "vitest";
import {
  checkLocalDateTime,
  dayKey,
  formatOffsetIso,
  formatTime,
  formatTimeOnDay,
  isValidTimezone,
  localDateTimeToEpochMs,
  offsetMsAt,
  zonedParts,
} from "../../src/core/time.ts";
import { jst } from "./helpers.ts";

const TOKYO = "Asia/Tokyo";
const NEW_YORK = "America/New_York";

describe("時刻の整形（画面設計書 2.9）", () => {
  const now = jst(2026, 11, 28, 12, 0);

  it.each([
    ["当日の時刻は、時と分だけ", jst(2026, 11, 28, 8, 30), "08:30"],
    ["秒は出さない", jst(2026, 11, 28, 8, 30, 59), "08:30"],
    ["当日の 0 時ちょうどは当日", jst(2026, 11, 28, 0, 0), "00:00"],
    ["当日の最後の 1 分は当日", jst(2026, 11, 28, 23, 59), "23:59"],
    ["前日は、月日を付ける", jst(2026, 11, 27, 18, 5), "11/27 18:05"],
    ["前日の最後の 1 分は前日", jst(2026, 11, 27, 23, 59, 59), "11/27 23:59"],
    ["月と日は桁をそろえない", jst(2026, 1, 5, 9, 0), "1/5 09:00"],
    ["翌日も、月日を付ける", jst(2026, 11, 29, 0, 0), "11/29 00:00"],
    ["前年の同じ月日は、当日ではない", jst(2025, 11, 28, 8, 30), "11/28 08:30"],
  ])("%s", (_name, epochMs, expected) => {
    expect(formatTime(epochMs, now, TOKYO)).toBe(expected);
  });

  it("設定のタイムゾーンで表示し、当日かどうかも設定のタイムゾーンで決める", () => {
    // 日本時間の 11/28 08:30 は、ニューヨークでは 11/27 18:30
    const epochMs = jst(2026, 11, 28, 8, 30);
    expect(formatTime(epochMs, epochMs, NEW_YORK)).toBe("18:30");
    // 日本時間で同じ日でも、ニューヨークでは日付をまたぐ
    expect(formatTime(jst(2026, 11, 28, 8, 30), jst(2026, 11, 28, 20, 0), TOKYO)).toBe("08:30");
    expect(formatTime(jst(2026, 11, 28, 8, 30), jst(2026, 11, 28, 20, 0), NEW_YORK)).toBe("11/27 18:30");
  });
});

describe("日付の値（当日かどうかの比較）", () => {
  it("設定のタイムゾーンで同じ日付なら同じ値になり、0 時に変わる", () => {
    expect(dayKey(jst(2026, 11, 28, 0, 0), TOKYO)).toBe(20261128);
    expect(dayKey(jst(2026, 11, 28, 23, 59, 59), TOKYO)).toBe(20261128);
    expect(dayKey(jst(2026, 11, 29, 0, 0), TOKYO)).toBe(20261129);
    // 日本時間の 11/28 08:30 は、ニューヨークでは 11/27
    expect(dayKey(jst(2026, 11, 28, 8, 30), NEW_YORK)).toBe(20261127);
  });

  it("日付の値で整形した結果は、その日のどの時刻を現在時刻にした結果とも同じ", () => {
    const today = dayKey(jst(2026, 11, 28, 12, 0), TOKYO);
    for (const epochMs of [jst(2026, 11, 28, 8, 30), jst(2026, 11, 27, 23, 59, 59), jst(2026, 11, 29, 0, 0), jst(2025, 11, 28, 8, 30)]) {
      for (const now of [jst(2026, 11, 28, 0, 0), jst(2026, 11, 28, 12, 0), jst(2026, 11, 28, 23, 59, 59)]) {
        expect(formatTimeOnDay(epochMs, today, TOKYO)).toBe(formatTime(epochMs, now, TOKYO));
      }
    }
  });
});

describe("一括チェックイン CSV の日時（PRD 7.3）", () => {
  it("設定のタイムゾーンのオフセット付き ISO 8601 で、秒まで書く", () => {
    expect(formatOffsetIso(jst(2025, 1, 23, 4, 56), TOKYO)).toBe("2025-01-23T04:56:00+09:00");
    expect(formatOffsetIso(jst(2026, 11, 28, 9, 30, 15) + 999, TOKYO)).toBe("2026-11-28T09:30:15+09:00");
  });

  it("オフセットは、その時刻のものを使う", () => {
    expect(formatOffsetIso(Date.UTC(2026, 6, 1, 12, 0, 0), NEW_YORK)).toBe("2026-07-01T08:00:00-04:00");
    expect(formatOffsetIso(Date.UTC(2026, 11, 1, 12, 0, 0), NEW_YORK)).toBe("2026-12-01T07:00:00-05:00");
    expect(formatOffsetIso(Date.UTC(2026, 0, 1, 0, 0, 0), "UTC")).toBe("2026-01-01T00:00:00+00:00");
    expect(formatOffsetIso(Date.UTC(2026, 0, 1, 0, 0, 0), "Asia/Kolkata")).toBe("2026-01-01T05:30:00+05:30");
  });
});

describe("タイムゾーン", () => {
  it("IANA のタイムゾーン名として解釈できるかを確かめる", () => {
    expect(isValidTimezone(TOKYO)).toBe(true);
    expect(isValidTimezone("UTC")).toBe(true);
    expect(isValidTimezone("Asia/Tokio")).toBe(false);
    expect(isValidTimezone("JST+9")).toBe(false);
    expect(isValidTimezone("")).toBe(false);
  });

  it("暦の値と UTC からの差を求める", () => {
    expect(zonedParts(jst(2026, 11, 27, 17, 30, 5), TOKYO)).toEqual({
      year: 2026,
      month: 11,
      day: 27,
      hour: 17,
      minute: 30,
      second: 5,
    });
    expect(zonedParts(jst(2026, 11, 28, 0, 0), TOKYO).hour).toBe(0);
    expect(offsetMsAt(jst(2026, 11, 27), TOKYO)).toBe(9 * 3600_000);
    expect(offsetMsAt(Date.UTC(2026, 6, 1), NEW_YORK)).toBe(-4 * 3600_000);
  });
});

describe("設定の期間のローカル日時（Design Doc 4.2、4.7）", () => {
  it("タイムゾーンで解釈してエポックミリ秒にする", () => {
    expect(localDateTimeToEpochMs("2026-11-27T17:30:00", TOKYO)).toEqual({ ok: true, epochMs: jst(2026, 11, 27, 17, 30) });
    // smol-toml の TomlDate#toISOString() は、ミリ秒を付ける
    expect(localDateTimeToEpochMs("2026-11-27T17:30:00.000", TOKYO)).toEqual({
      ok: true,
      epochMs: jst(2026, 11, 27, 17, 30),
    });
    expect(localDateTimeToEpochMs("2026-11-28T00:00:00", TOKYO)).toEqual({ ok: true, epochMs: jst(2026, 11, 28) });
    expect(localDateTimeToEpochMs("2026-07-01T08:00:00", NEW_YORK)).toEqual({
      ok: true,
      epochMs: Date.UTC(2026, 6, 1, 12, 0, 0),
    });
    expect(localDateTimeToEpochMs("2026-12-01T07:00:00", NEW_YORK)).toEqual({
      ok: true,
      epochMs: Date.UTC(2026, 11, 1, 12, 0, 0),
    });
  });

  it("整形と往復する", () => {
    for (const local of ["2026-03-08T01:59:59", "2026-03-08T03:00:00", "2026-11-01T00:59:59", "2026-11-01T02:00:00"]) {
      const result = localDateTimeToEpochMs(local, NEW_YORK);
      expect(result.ok).toBe(true);
      if (result.ok) expect(formatOffsetIso(result.epochMs, NEW_YORK).slice(0, 19)).toBe(local);
    }
  });

  it.each([
    ["オフセット付きの日時", "2026-11-27T17:30:00+09:00", "format"],
    ["UTC の日時", "2026-11-27T17:30:00Z", "format"],
    ["日付だけ", "2026-11-27", "format"],
    ["時刻だけ", "17:30:00", "format"],
    ["空白で区切った日時", "2026-11-27 17:30:00", "format"],
    ["秒のない日時", "2026-11-27T17:30", "format"],
    ["暦にない日付", "2026-02-30T10:00:00", "invalidDate"],
    ["暦にない月", "2026-13-01T10:00:00", "invalidDate"],
    ["24 時", "2026-11-27T24:00:00", "invalidDate"],
    ["60 分", "2026-11-27T10:60:00", "invalidDate"],
  ] as const)("%s は誤り", (_name, local, reason) => {
    expect(localDateTimeToEpochMs(local, TOKYO)).toEqual({ ok: false, reason });
    expect(checkLocalDateTime(local)).toBe(reason);
  });

  it("うるう年の 2 月 29 日は通す", () => {
    expect(checkLocalDateTime("2028-02-29T10:00:00")).toBe("ok");
    expect(checkLocalDateTime("2026-02-29T10:00:00")).toBe("invalidDate");
  });

  it("夏時間の切り替えで存在しない時刻と、2 回ある時刻は誤りにする", () => {
    // ニューヨークでは、2026-03-08 の 02:00〜03:00 が存在せず、2026-11-01 の 01:00〜02:00 が 2 回ある
    expect(localDateTimeToEpochMs("2026-03-08T02:30:00", NEW_YORK)).toEqual({ ok: false, reason: "nonexistent" });
    expect(localDateTimeToEpochMs("2026-11-01T01:30:00", NEW_YORK)).toEqual({ ok: false, reason: "ambiguous" });
  });
});
