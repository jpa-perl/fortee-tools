import { describe, expect, it } from "vitest";
import type { PublishedConfig } from "../../src/core/config.ts";
import { buildSearchIndex, normalizeSearchText, search, SEARCH_LIMIT } from "../../src/core/search.ts";
import { buildSnapshotIndex, type Ticket } from "../../src/core/snapshot.ts";
import { config, EVE, EVENT_IDS, MAIN, snapshotsOf, ticket } from "./helpers.ts";

describe("検索の正規化（Design Doc 5.5）", () => {
  it.each([
    ["全角の英数字を半角にする（NFKC）", "Ａ－１２", "a12"],
    ["小文字にする", "KaruPaneRura", "karupanerura"],
    ["カタカナをひらがなにする", "ヤマダ", "やまだ"],
    ["半角カタカナもひらがなにする", "ﾔﾏﾀﾞ", "やまだ"],
    ["小さいカタカナと ヴ、ヵ、ヶ", "ァィゥェォッャュョヴヵヶ", "ぁぃぅぇぉっゃゅょゔゕゖ"],
    ["空白を除く", " 山田　太郎\t", "山田太郎"],
    ["- と _ と . を除く", "a-b_c.d", "abcd"],
    ["ー と ・ を除く", "サーバー・ルーム", "さばるむ"],
    ["全角の ． と ＿ も除く", "ａ．ｂ＿ｃ", "abc"],
    ["漢字とひらがなは変えない", "山田たろう", "山田たろう"],
    ["除く文字だけなら空になる", " -_ー・. ", ""],
  ])("%s", (_name, input, expected) => {
    expect(normalizeSearchText(input)).toBe(expected);
  });
});

function indexOf(tickets: readonly Ticket[], search_: PublishedConfig["search"] = config.search) {
  return buildSearchIndex(buildSnapshotIndex(snapshotsOf(tickets), EVENT_IDS), { search: search_ });
}

const users = (hits: ReturnType<typeof search>) => hits.map((hit) => hit.userName);

describe("検索（Design Doc 5.5、FR-24、画面設計書 S05）", () => {
  const tickets = [
    ticket({ eventId: MAIN, userName: "karupanerura", ticketNo: "A-12", name: "かるぱ ねるら" }),
    ticket({ eventId: EVE, userName: "karupanerura", ticketNo: "E-7", name: "" }),
    ticket({ eventId: MAIN, userName: "yamada", ticketNo: "A-120", name: "ヤマダ タロウ" }),
    ticket({ eventId: MAIN, userName: "a12fan", ticketNo: "B-3", name: "" }),
    ticket({
      eventId: MAIN,
      userName: "speaker",
      ticketNo: "S-1",
      name: "",
      answers: { "スピーカー名札に記載するお名前": "Larry Wall" },
    }),
    ticket({ eventId: MAIN, userName: "xa12", ticketNo: "B-4", name: "" }),
  ];
  const index = indexOf(tickets);

  it("検索語が空なら、候補を出さない", () => {
    expect(search(index, "")).toEqual([]);
    expect(search(index, "   ")).toEqual([]);
    // 正規化して空になる検索語も同じ
    expect(search(index, "-")).toEqual([]);
  });

  it("完全一致、前方一致、それ以外の順に並べる", () => {
    // "A-12" は、karupanerura のチケット番号に完全一致、yamada のチケット番号（A-120）と a12fan のユーザ名に前方一致、
    // xa12 のユーザ名に部分一致する
    expect(search(index, "A-12")).toEqual([
      { userName: "karupanerura", match: "exact" },
      { userName: "a12fan", match: "prefix" },
      { userName: "yamada", match: "prefix" },
      { userName: "xa12", match: "partial" },
    ]);
  });

  it("同じ順位の中は、ユーザ名の昇順", () => {
    const sameRank = indexOf(["delta", "Bravo", "alpha", "charlie", "Alpha"].map((userName) => ticket({ eventId: MAIN, userName, ticketNo: "Z-9" })));
    // 符号単位の順（大文字が先）
    expect(users(search(sameRank, "z9"))).toEqual(["Alpha", "Bravo", "alpha", "charlie", "delta"]);
  });

  it("文字の揺れを許す。全角、大文字、カタカナ、区切りの記号", () => {
    expect(users(search(index, "ａ１２"))[0]).toBe("karupanerura");
    expect(users(search(index, "KARUPANERURA"))).toEqual(["karupanerura"]);
    expect(users(search(index, "やまだ"))).toEqual(["yamada"]);
    expect(users(search(index, "ﾔﾏﾀﾞﾀﾛｳ"))).toEqual(["yamada"]);
    expect(users(search(index, "カルパ"))).toEqual(["karupanerura"]);
    expect(users(search(index, "e7"))).toEqual(["karupanerura"]);
  });

  it("部分一致で探す", () => {
    expect(search(index, "ねるら")).toEqual([{ userName: "karupanerura", match: "partial" }]);
    expect(search(index, "pane")).toEqual([{ userName: "karupanerura", match: "partial" }]);
  });

  it("一致しなければ、候補は 0 件", () => {
    expect(search(index, "存在しない")).toEqual([]);
  });

  it("ユーザのすべてのチケットの値を集める。順位は、最も強い一致で決める", () => {
    // karupanerura は、前夜祭のチケット番号でも見つかる
    expect(search(index, "E-7")).toEqual([{ userName: "karupanerura", match: "exact" }]);
    // 候補はユーザ単位で、チケットが 2 枚あっても 1 件
    expect(users(search(index, "karupa"))).toEqual(["karupanerura"]);
  });

  it("search.answers の列も検索対象にする", () => {
    expect(search(index, "larry")).toEqual([{ userName: "speaker", match: "prefix" }]);
    expect(search(index, "LarryWall")).toEqual([{ userName: "speaker", match: "exact" }]);
  });

  it("search.answers の列は、その項目のイベントのチケットからだけ集める", () => {
    const sameField = ticket({
      eventId: EVE,
      userName: "eve-only",
      ticketNo: "E-9",
      answers: { "スピーカー名札に記載するお名前": "Damian" },
    });
    expect(search(indexOf([sameField]), "damian")).toEqual([]);
  });

  it("search.columns にない列は、検索対象にしない", () => {
    const onlyTicketNo = indexOf(tickets, { columns: ["ticketNo"], answers: [] });
    expect(search(onlyTicketNo, "karupanerura")).toEqual([]);
    expect(search(onlyTicketNo, "larry")).toEqual([]);
    expect(users(search(onlyTicketNo, "A-12"))).toEqual(["karupanerura", "yamada"]);
  });

  it("20 件で切る。完全一致した候補は、ユーザ名の順が後でも一覧に入る", () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      ticket({ eventId: MAIN, userName: `user${String(i).padStart(2, "0")}`, ticketNo: `C-${100 + i}` }),
    );
    const exact = ticket({ eventId: MAIN, userName: "zzz", ticketNo: "C-1" });
    const hits = search(indexOf([...many, exact]), "C-1");
    expect(hits).toHaveLength(SEARCH_LIMIT);
    expect(hits[0]).toEqual({ userName: "zzz", match: "exact" });
    expect(users(hits).slice(1)).toEqual(many.slice(0, 19).map((t) => t.userName));
    expect(search(indexOf([...many, exact]), "C-1", 3)).toHaveLength(3);
  });

  it("スナップショットの値は変えない", () => {
    const original = ticket({ eventId: MAIN, userName: "Ｆｕｌｌ Ｗｉｄｔｈ", ticketNo: "Ａ－１" });
    const snapshotIndex = buildSnapshotIndex(snapshotsOf([original]), EVENT_IDS);
    const hits = search(buildSearchIndex(snapshotIndex, config), "fullwidth");
    expect(hits).toEqual([{ userName: "Ｆｕｌｌ Ｗｉｄｔｈ", match: "exact" }]);
    expect(snapshotIndex.byUser.get("Ｆｕｌｌ Ｗｉｄｔｈ")?.[0]?.ticketNo).toBe("Ａ－１");
  });
});
