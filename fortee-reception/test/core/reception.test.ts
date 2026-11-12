import { describe, expect, it } from "vitest";
import type { Reception } from "../../src/core/config.ts";
import {
  nextBoundary,
  receptionDisplayName,
  receptionStatus,
  selectReception,
  suggestSwitch,
} from "../../src/core/reception.ts";
import { config, EVE, eveReception, jst, MAIN, mainReception, NURSERY, PARTY, partyReception } from "./helpers.ts";

describe("自動の選択（FR-6, 7）と期間の境界（FR-3）", () => {
  it.each([
    ["前夜祭の開始の 1 ミリ秒前は受付なし", jst(2026, 11, 27, 17, 30) - 1, null],
    ["開始の時刻ちょうどは、その期間に含まれる", jst(2026, 11, 27, 17, 30), "eve"],
    ["終了の 1 ミリ秒前は、その期間に含まれる", jst(2026, 11, 27, 21, 0) - 1, "eve"],
    ["終了の時刻ちょうどは、その期間に含まれない", jst(2026, 11, 27, 21, 0), null],
    ["夜間は受付なし", jst(2026, 11, 28, 3, 0), null],
    ["本編の 1 日目", jst(2026, 11, 28, 12, 0), "main"],
    ["本編の終了の 1 ミリ秒前は本編", jst(2026, 11, 28, 17, 30) - 1, "main"],
    ["本編の終了と同じ時刻に始まる懇親会の期間に含まれる", jst(2026, 11, 28, 17, 30), "party"],
    ["本編の 2 日目", jst(2026, 11, 29, 9, 30), "main"],
    ["最後の期間の後は受付なし", jst(2026, 11, 29, 18, 0), null],
  ])("%s", (_name, now, expected) => {
    expect(selectReception(config, now)?.id ?? null).toBe(expected);
  });
});

describe("次の境界（Design Doc 5.2）", () => {
  it.each([
    ["最初の期間の前は、最初の開始", jst(2026, 11, 1), jst(2026, 11, 27, 17, 30)],
    ["開始の時刻ちょうどからは、その期間の終了", jst(2026, 11, 27, 17, 30), jst(2026, 11, 27, 21, 0)],
    ["期間の間は、次の開始", jst(2026, 11, 27, 21, 0), jst(2026, 11, 28, 9, 30)],
    ["終了と開始が同じ時刻の境界", jst(2026, 11, 28, 12, 0), jst(2026, 11, 28, 17, 30)],
    ["境界の時刻ちょうどからは、その次の境界", jst(2026, 11, 28, 17, 30), jst(2026, 11, 28, 20, 30)],
    ["最後の期間の中は、その終了", jst(2026, 11, 29, 12, 0), jst(2026, 11, 29, 18, 0)],
  ])("%s", (_name, time, expected) => {
    expect(nextBoundary(config, time)).toBe(expected);
  });

  it("最後の終了からは、境界がない", () => {
    expect(nextBoundary(config, jst(2026, 11, 29, 18, 0))).toBeNull();
    expect(nextBoundary({ receptions: [] }, 0)).toBeNull();
  });
});

describe("受付の状態（画面設計書 S02-M1）", () => {
  it.each([
    ["期間の前", jst(2026, 11, 28, 9, 0), "upcoming"],
    ["期間中", jst(2026, 11, 28, 9, 30), "inPeriod"],
    ["期間の間で、これから始まる期間がある", jst(2026, 11, 28, 17, 30), "upcoming"],
    ["2 つ目の期間中", jst(2026, 11, 29, 17, 59), "inPeriod"],
    ["すべての期間の後", jst(2026, 11, 29, 18, 0), "ended"],
  ] as const)("%s", (_name, now, expected) => {
    expect(receptionStatus(mainReception, now)).toBe(expected);
  });
});

describe("切り替えの提案（FR-9）", () => {
  const suggest = (current: Reception | null, now: number, eventId: string, receptions = config.receptions) => {
    const suggestion = suggestSwitch({ receptions }, current, now, eventId);
    return suggestion === null ? null : { id: suggestion.reception.id, outOfPeriod: suggestion.outOfPeriod };
  };

  it("懇親会受付の時間帯に本編のチケットを読むと、期間外の本編受付を提案し、終了した前夜祭受付は提案しない（PRD 11 章）", () => {
    expect(suggest(partyReception, jst(2026, 11, 28, 18, 0), MAIN)).toEqual({ id: "main", outOfPeriod: true });
  });

  it("期間中の受付は、期間外の警告なしで提案する", () => {
    // 手動の上書きで懇親会受付にしている間に、本編の期間中に本編のチケットを読んだ
    expect(suggest(partyReception, jst(2026, 11, 28, 12, 0), MAIN)).toEqual({ id: "main", outOfPeriod: false });
  });

  it("期間中の候補を、これから始まる候補より先に選ぶ", () => {
    // 前夜祭の期間中。前夜祭受付（期間中）と本編受付（これから）が本編のチケットを受け付ける
    expect(suggest(partyReception, jst(2026, 11, 27, 18, 0), MAIN)).toEqual({ id: "eve", outOfPeriod: false });
  });

  it("これから始まる候補のうち、開始までの時間が最も短いものを選ぶ", () => {
    // 前夜祭の前。前夜祭受付の開始のほうが、本編受付の開始より近い
    expect(suggest(partyReception, jst(2026, 11, 27, 12, 0), MAIN)).toEqual({ id: "eve", outOfPeriod: true });
  });

  it("終了した候補より、これから始まる候補を選ぶ。終了のほうが現在時刻に近くても変わらない", () => {
    // 前夜祭の終了の 1 分後。本編受付の開始は 12 時間以上先
    expect(suggest(partyReception, jst(2026, 11, 27, 21, 1), MAIN)).toEqual({ id: "main", outOfPeriod: true });
  });

  it("終了していない候補がなければ、最も最近に終了した受付を選ぶ", () => {
    const now = jst(2026, 11, 30, 10, 0);
    expect(suggest(partyReception, now, MAIN)).toEqual({ id: "main", outOfPeriod: true });
    // 設定の順によらない
    expect(suggest(partyReception, now, MAIN, [mainReception, eveReception, partyReception])).toEqual({
      id: "main",
      outOfPeriod: true,
    });
  });

  it("期間の間にある受付は、終了ではない。提案の候補になる", () => {
    // 11/28 の夜。本編受付は 1 日目を終えているが、2 日目がこれから始まるので、終了ではない
    expect(suggest(partyReception, jst(2026, 11, 28, 21, 0), MAIN)).toEqual({ id: "main", outOfPeriod: true });
  });

  describe("隔たりは、最も近い期間までの時間で測る（終わった期間も数える）", () => {
    // a は 1 日目を終えて 2 日目がこれから、b はこれから始まる。どちらも終了していない
    const base = { accept: [MAIN], require: [MAIN], checkin: [MAIN], rejectMessage: "" };
    const day1End = jst(2026, 11, 28, 17, 0);
    const a: Reception = {
      ...base,
      id: "a",
      name: "A",
      periods: [
        { start: jst(2026, 11, 28, 9, 0), end: day1End },
        { start: jst(2026, 11, 29, 9, 0), end: jst(2026, 11, 29, 17, 0) },
      ],
    };
    const bStart = jst(2026, 11, 28, 19, 0);
    const b: Reception = { ...base, id: "b", name: "B", periods: [{ start: bStart, end: jst(2026, 11, 28, 21, 0) }] };

    it("10 分前に期間を終えた受付は、2 時間後に始まる受付より近い", () => {
      expect(suggest(null, day1End + 10 * 60_000, MAIN, [b, a])).toEqual({ id: "a", outOfPeriod: true });
    });

    it("始まるほうが近くなれば、始まるほうを選ぶ", () => {
      expect(suggest(null, bStart - 10 * 60_000, MAIN, [a, b])).toEqual({ id: "b", outOfPeriod: true });
    });

    it("隔たりが同じなら、これから始まるほうを選ぶ。設定の順によらない", () => {
      const middle = (day1End + bStart) / 2;
      expect(suggest(null, middle, MAIN, [a, b])).toEqual({ id: "b", outOfPeriod: true });
      expect(suggest(null, middle, MAIN, [b, a])).toEqual({ id: "b", outOfPeriod: true });
    });

    it("終了した受付は、どれだけ近くても、終了していない受付より後になる", () => {
      const ended: Reception = { ...base, id: "ended", name: "E", periods: [{ start: jst(2026, 11, 28, 9, 0), end: day1End }] };
      expect(suggest(null, day1End + 60_000, MAIN, [ended, b])).toEqual({ id: "b", outOfPeriod: true });
    });
  });

  it("現在の受付は提案しない", () => {
    expect(suggest(mainReception, jst(2026, 11, 28, 12, 0), EVE)).toEqual({ id: "eve", outOfPeriod: true });
    expect(suggest(eveReception, jst(2026, 11, 28, 12, 0), EVE)).toBeNull();
  });

  it("どの受付も受け付けないイベントは、提案がない（FR-10）", () => {
    expect(suggest(mainReception, jst(2026, 11, 28, 12, 0), NURSERY)).toBeNull();
  });

  it("現在の受付だけが受け付けるイベントは、提案がない", () => {
    expect(suggest(partyReception, jst(2026, 11, 28, 18, 0), PARTY)).toBeNull();
  });
});

describe("記録の受付の表示名（画面設計書 2.9）", () => {
  it("いまの設定の表示名を引く。設定から消えた受付は、識別子をそのまま出す", () => {
    expect(receptionDisplayName(config, "eve")).toBe("前夜祭受付");
    expect(receptionDisplayName(config, "removed")).toBe("removed");
    expect(receptionDisplayName(config, null)).toBeNull();
  });
});
