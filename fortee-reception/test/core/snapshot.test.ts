import { describe, expect, it } from "vitest";
import { buildSnapshotIndex, combineNames, compareTicketNo } from "../../src/core/snapshot.ts";
import { EVE, EVENT_IDS, MAIN, PARTY, snapshotsOf, ticket } from "./helpers.ts";

describe("チケット番号の順", () => {
  it.each([
    ["A-2", "A-12"],
    ["A-12", "B-1"],
    ["A-9", "A-10"],
    ["A-1", "A-1-2"],
    ["9", "10"],
    ["A-02", "A-2"],
    ["A", "A-1"],
    ["A-99999999999999999999", "A-100000000000000000000"],
  ])("%s は %s より前", (a, b) => {
    expect(compareTicketNo(a, b)).toBeLessThan(0);
    expect(compareTicketNo(b, a)).toBeGreaterThan(0);
  });

  it("同じ番号は同じ順位", () => {
    expect(compareTicketNo("A-12", "A-12")).toBe(0);
  });
});

describe("スナップショットの索引（Design Doc 5.1）", () => {
  const main12 = ticket({ eventId: MAIN, userName: "alice", ticketNo: "A-12" });
  const main2 = ticket({ eventId: MAIN, userName: "alice", ticketNo: "A-2" });
  const eve1 = ticket({ eventId: EVE, userName: "alice", ticketNo: "E-1" });
  const party1 = ticket({ eventId: PARTY, userName: "bob", ticketNo: "P-1" });
  const other = ticket({ eventId: "not-in-config", userName: "alice", ticketNo: "X-1" });
  const index = buildSnapshotIndex(snapshotsOf([eve1, main12, party1, main2, other]), EVENT_IDS);

  it("チケットトークンからチケットを引ける", () => {
    expect(index.byToken.get(main12.ticketToken)).toEqual(main12);
    expect(index.byToken.get("x".repeat(32))).toBeUndefined();
  });

  it("ユーザのチケットは、設定のイベントの順、同じイベントの中はチケット番号の順", () => {
    expect(index.byUser.get("alice")?.map((t) => t.ticketNo)).toEqual(["A-2", "A-12", "E-1"]);
    expect(index.byUser.get("bob")?.map((t) => t.ticketNo)).toEqual(["P-1"]);
  });

  it("ユーザの同一性は、ユーザ名の完全一致で見る。正規化しない", () => {
    const tickets = [
      ticket({ eventId: MAIN, userName: "Alice" }),
      ticket({ eventId: MAIN, userName: "alice" }),
      ticket({ eventId: MAIN, userName: "alice " }),
    ];
    const byUser = buildSnapshotIndex(snapshotsOf(tickets), EVENT_IDS).byUser;
    expect([...byUser.keys()].sort()).toEqual(["Alice", "alice", "alice "]);
  });

  it("イベントごとの版を持つ", () => {
    expect(index.versions).toEqual({ [MAIN]: 1764200000000, [EVE]: 1764200000000, [PARTY]: 1764200000000 });
  });

  it("設定にないイベントのスナップショットは索引に入れない", () => {
    expect(index.byToken.has(other.ticketToken)).toBe(false);
    expect(index.versions["not-in-config"]).toBeUndefined();
  });
});

describe("ユーザの Name（PRD 7.1、Design Doc 4.3）", () => {
  const names = (...values: string[]) => combineNames(values.map((name) => ({ name })));

  it("空でない Name を、渡された順に「、」でつなぐ", () => {
    expect(names("山田太郎", "", "Taro")).toBe("山田太郎、Taro");
  });

  it("重複は文字列の完全一致で除き、正規化しない", () => {
    expect(names("山田太郎", "山田太郎", "山田 太郎", "Taro", "taro")).toBe("山田太郎、山田 太郎、Taro、taro");
  });

  it("どの Name も空なら空文字", () => {
    expect(names("", "")).toBe("");
    expect(names()).toBe("");
  });
});
