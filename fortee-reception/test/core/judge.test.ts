import { describe, expect, it } from "vitest";
import type { Reception } from "../../src/core/config.ts";
import { buildUserView, judge, type JudgeInput, type Judgement, parseTicketQr } from "../../src/core/judge.ts";
import { aggregate, type OrderedRecord } from "../../src/core/records.ts";
import { buildSnapshotIndex, type Ticket } from "../../src/core/snapshot.ts";
import {
  cancel,
  checkin,
  config,
  EVE,
  EVENT_IDS,
  eveReception,
  jst,
  MAIN,
  mainReception,
  NURSERY,
  PARTY,
  partyReception,
  snapshotsOf,
  ticket,
  uuid,
} from "./helpers.ts";

describe("QR の文字列の検証（FR-11）", () => {
  it("fortee: で始まる 39 文字から、チケットトークンを取り出す", () => {
    expect(parseTicketQr("fortee:aRZAnjQt1sepvZ2OTJLNQZ1MsAI93cAw")).toBe("aRZAnjQt1sepvZ2OTJLNQZ1MsAI93cAw");
  });

  it.each([
    ["URL 形式の QR", "https://fortee.jp/yapc-tokyo-2026/ticket/aRZAnjQt1sepvZ2OTJLNQZ1MsAI93cAw"],
    ["接頭辞がない", "aRZAnjQt1sepvZ2OTJLNQZ1MsAI93cAw"],
    ["トークンが 31 文字", "fortee:aRZAnjQt1sepvZ2OTJLNQZ1MsAI93cA"],
    ["トークンが 33 文字", "fortee:aRZAnjQt1sepvZ2OTJLNQZ1MsAI93cAwx"],
    ["英数字でない文字", "fortee:aRZAnjQt1sepvZ2OTJLNQZ1MsAI93c-w"],
    ["接頭辞の大文字", "Fortee:aRZAnjQt1sepvZ2OTJLNQZ1MsAI93cAw"],
    ["前の空白", " fortee:aRZAnjQt1sepvZ2OTJLNQZ1MsAI93cAw"],
    ["後ろの改行", "fortee:aRZAnjQt1sepvZ2OTJLNQZ1MsAI93cAw\n"],
    ["空文字", ""],
  ])("%s は形式外", (_name, text) => {
    expect(parseTicketQr(text)).toBeNull();
  });
});

// 判定の表（画面設計書 2.4）。時刻は、前夜祭受付の期間中
const NOW = jst(2026, 11, 27, 18, 0);

type Scene = {
  tickets: Ticket[];
  records?: OrderedRecord[];
};

function run(scene: Scene, input: JudgeInput, reception: Reception, now = NOW): Judgement {
  const index = buildSnapshotIndex(snapshotsOf(scene.tickets), EVENT_IDS);
  return judge(input, reception, index, aggregate(scene.records ?? []), { config, now });
}

const qr = (t: Ticket): JudgeInput => ({ kind: "qr", ticket: t });
const tokens = (tickets: readonly Ticket[]) => tickets.map((t) => t.ticketToken);

describe("判定（Design Doc 5.4、画面設計書 2.4）: QR の読み取り", () => {
  it("成功: 本編受付で本編のチケットを読むと、そのチケットを済みにする", () => {
    const main = ticket({ eventId: MAIN, userName: "alice" });
    const result = run({ tickets: [main] }, qr(main), mainReception);
    expect(result).toMatchObject({ kind: "success", newlyDone: [main] });
  });

  it("成功: 前夜祭受付で前夜祭のチケットを読むと、本編のチケット（1 枚）も済みにする（FR-13）", () => {
    const eve = ticket({ eventId: EVE, userName: "alice" });
    const main = ticket({ eventId: MAIN, userName: "alice" });
    const result = run({ tickets: [eve, main] }, qr(eve), eveReception);
    expect(result.kind).toBe("success");
    // チケットの並び順（設定のイベントの順）で返す
    if (result.kind === "success") expect(tokens(result.newlyDone)).toEqual(tokens([main, eve]));
  });

  it("成功: 前夜祭受付で本編のチケットを読んでも、前夜祭のチケットを持っていれば両方を済みにする", () => {
    const eve = ticket({ eventId: EVE, userName: "alice" });
    const main = ticket({ eventId: MAIN, userName: "alice" });
    const result = run({ tickets: [eve, main] }, qr(main), eveReception);
    expect(result.kind).toBe("success");
    if (result.kind === "success") expect(tokens(result.newlyDone)).toEqual(tokens([main, eve]));
  });

  it("成功: 既に済みのチケットは変えず、未のチケットだけを済みにする（FR-13）", () => {
    const eve = ticket({ eventId: EVE, userName: "alice" });
    const main = ticket({ eventId: MAIN, userName: "alice" });
    const result = run({ tickets: [eve, main], records: [checkin(1, main.ticketToken, 1000)] }, qr(eve), eveReception);
    expect(result.kind).toBe("success");
    if (result.kind === "success") expect(tokens(result.newlyDone)).toEqual(tokens([eve]));
  });

  it("成功: ほかのユーザのチケットと記録は見ない（FR-12）", () => {
    const main = ticket({ eventId: MAIN, userName: "alice" });
    const others = ticket({ eventId: MAIN, userName: "bob" });
    const result = run({ tickets: [main, others], records: [checkin(1, others.ticketToken, 1000)] }, qr(main), mainReception);
    expect(result.kind).toBe("success");
    expect(result.user.tickets).toHaveLength(1);
  });

  it("成功: 同じイベントのチケットを複数持つときは、読み取ったチケットだけを済みにする（FR-15）", () => {
    const first = ticket({ eventId: MAIN, userName: "alice" });
    const second = ticket({ eventId: MAIN, userName: "alice" });
    const result = run({ tickets: [first, second] }, qr(second), mainReception);
    expect(result.kind).toBe("success");
    if (result.kind === "success") expect(tokens(result.newlyDone)).toEqual(tokens([second]));
  });

  it("成功: 同じイベントのほかのチケットが済みでも、読み取った未のチケットは済みにする（FR-15）", () => {
    const first = ticket({ eventId: MAIN, userName: "alice" });
    const second = ticket({ eventId: MAIN, userName: "alice" });
    const result = run({ tickets: [first, second], records: [checkin(1, first.ticketToken, 1000)] }, qr(second), mainReception);
    expect(result.kind).toBe("success");
    if (result.kind === "success") expect(tokens(result.newlyDone)).toEqual(tokens([second]));
  });

  it("成功: 取り消したチケットは、もう一度チェックインできる（FR-30）", () => {
    const main = ticket({ eventId: MAIN, userName: "alice" });
    const records = [checkin(1, main.ticketToken, 1000), cancel(2, main.ticketToken, 2000, [1])];
    expect(run({ tickets: [main], records }, qr(main), mainReception).kind).toBe("success");
  });

  it("成功: fortee 側でだけ済みのチケットは、未として扱う（FR-16）", () => {
    const main = ticket({ eventId: MAIN, userName: "alice", forteeCheckedIn: true });
    expect(run({ tickets: [main] }, qr(main), mainReception).kind).toBe("success");
  });

  it("続けて読み取り: 読み取っていないイベントに未のチケットが複数あると、そのイベントが残る（FR-15）", () => {
    const eve = ticket({ eventId: EVE, userName: "alice" });
    const main1 = ticket({ eventId: MAIN, userName: "alice" });
    const main2 = ticket({ eventId: MAIN, userName: "alice" });
    const result = run({ tickets: [eve, main1, main2] }, qr(eve), eveReception);
    expect(result.kind).toBe("continue");
    if (result.kind === "continue") {
      expect(tokens(result.newlyDone)).toEqual(tokens([eve]));
      expect(result.remainingEvents).toEqual([MAIN]);
    }
  });

  it("続けて読み取り: 読み取ったチケットが済みでも、ほかのイベントが残れば続けて読み取り", () => {
    const eve = ticket({ eventId: EVE, userName: "alice" });
    const main1 = ticket({ eventId: MAIN, userName: "alice" });
    const main2 = ticket({ eventId: MAIN, userName: "alice" });
    const result = run(
      { tickets: [eve, main1, main2], records: [checkin(1, eve.ticketToken, 1000)] },
      qr(eve),
      eveReception,
    );
    expect(result).toMatchObject({ kind: "continue", newlyDone: [], remainingEvents: [MAIN] });
  });

  it("成功: 複数あるイベントのチケットを 1 枚読むと、残るイベントがなくなる", () => {
    const eve = ticket({ eventId: EVE, userName: "alice" });
    const main1 = ticket({ eventId: MAIN, userName: "alice" });
    const main2 = ticket({ eventId: MAIN, userName: "alice" });
    const result = run(
      { tickets: [eve, main1, main2], records: [checkin(1, eve.ticketToken, 1000)] },
      qr(main2),
      eveReception,
    );
    expect(result.kind).toBe("success");
    if (result.kind === "success") expect(tokens(result.newlyDone)).toEqual(tokens([main2]));
  });

  it("成功: 複数あっても、いずれか 1 枚が済みのイベントは済みとして扱い、残らない（FR-15）", () => {
    const eve = ticket({ eventId: EVE, userName: "alice" });
    const main1 = ticket({ eventId: MAIN, userName: "alice" });
    const main2 = ticket({ eventId: MAIN, userName: "alice" });
    const result = run(
      { tickets: [eve, main1, main2], records: [checkin(1, main2.ticketToken, 1000)] },
      qr(eve),
      eveReception,
    );
    expect(result.kind).toBe("success");
    if (result.kind === "success") expect(tokens(result.newlyDone)).toEqual(tokens([eve]));
  });

  it("済み: 新たに済みにするチケットも、残るイベントもない。根拠は、最も新しい記録（FR-16）", () => {
    const eve = ticket({ eventId: EVE, userName: "alice" });
    const main = ticket({ eventId: MAIN, userName: "alice" });
    const records = [checkin(1, main.ticketToken, 1000), checkin(2, eve.ticketToken, 2000)];
    const result = run({ tickets: [eve, main], records }, qr(main), eveReception);
    expect(result.kind).toBe("alreadyDone");
    if (result.kind === "alreadyDone") expect(result.basis.recordId).toBe(uuid(2));
  });

  it("済み: 読み取ったチケット自体が済みかではなく、チェックインするイベントのチケットで判定する（FR-16）", () => {
    // 受け付けるイベントが本編と懇親会、チェックインするイベントが懇親会の受付
    const reception: Reception = { ...partyReception, accept: [MAIN, PARTY], require: [MAIN], checkin: [PARTY] };
    const main = ticket({ eventId: MAIN, userName: "alice" });
    const party = ticket({ eventId: PARTY, userName: "alice" });
    const result = run({ tickets: [main, party], records: [checkin(1, party.ticketToken, 1000)] }, qr(main), reception);
    expect(result.kind).toBe("alreadyDone");
    if (result.kind === "alreadyDone") expect(result.basis.recordId).toBe(uuid(1));
  });

  it("済み: 根拠は、打ち消されていない最も早い記録。チケットのあいだでは最も新しいもの", () => {
    const eve = ticket({ eventId: EVE, userName: "alice" });
    const main = ticket({ eventId: MAIN, userName: "alice" });
    const records = [
      checkin(1, main.ticketToken, 1000),
      cancel(2, main.ticketToken, 1500, [1]),
      checkin(3, main.ticketToken, 3000),
      checkin(4, main.ticketToken, 4000),
      checkin(5, eve.ticketToken, 2000),
    ];
    const result = run({ tickets: [eve, main], records }, qr(eve), eveReception);
    expect(result.kind).toBe("alreadyDone");
    if (result.kind === "alreadyDone") expect(result.basis.recordId).toBe(uuid(3));
  });

  it("済み: チェックインするイベントでないチケットの記録は、根拠にしない", () => {
    const main = ticket({ eventId: MAIN, userName: "alice" });
    const party = ticket({ eventId: PARTY, userName: "alice" });
    const records = [checkin(1, main.ticketToken, 1000), checkin(2, party.ticketToken, 9000)];
    const result = run({ tickets: [main, party], records }, qr(main), mainReception);
    expect(result.kind).toBe("alreadyDone");
    if (result.kind === "alreadyDone") expect(result.basis.recordId).toBe(uuid(1));
  });

  it("切替提案: 現在の受付は受け付けないが、別の受付なら受け付ける（FR-9）", () => {
    const main = ticket({ eventId: MAIN, userName: "alice" });
    // 懇親会受付の時間帯。本編受付は期間外
    const result = run({ tickets: [main] }, qr(main), partyReception, jst(2026, 11, 28, 18, 0));
    expect(result).toMatchObject({ kind: "suggestSwitch", reception: { id: "main" }, outOfPeriod: true });
  });

  it("切替提案: 期間中の受付なら、期間外の警告はない", () => {
    const party = ticket({ eventId: PARTY, userName: "alice" });
    // 手動の上書きで本編受付にしている間の、懇親会受付の時間帯
    const result = run({ tickets: [party] }, qr(party), mainReception, jst(2026, 11, 28, 18, 0));
    expect(result).toMatchObject({ kind: "suggestSwitch", reception: { id: "party" }, outOfPeriod: false });
  });

  it("切替提案: 所持が必須の判定より先に見る", () => {
    // 懇親会のチケットを持たない人の本編のチケットを、懇親会受付で読んだ
    const main = ticket({ eventId: MAIN, userName: "alice" });
    expect(run({ tickets: [main] }, qr(main), partyReception).kind).toBe("suggestSwitch");
  });

  it("対象外: どの受付も受け付けない（FR-10）", () => {
    const nursery = ticket({ eventId: NURSERY, userName: "alice" });
    const main = ticket({ eventId: MAIN, userName: "alice" });
    const result = run({ tickets: [nursery, main] }, qr(nursery), mainReception);
    expect(result.kind).toBe("outOfScope");
    expect(result.user.tickets).toHaveLength(2);
  });

  it("拒否: 所持が必須のイベントのチケットを持たない（FR-14）", () => {
    const main = ticket({ eventId: MAIN, userName: "alice" });
    const result = run({ tickets: [main] }, qr(main), eveReception);
    expect(result).toMatchObject({ kind: "rejected", message: "前夜祭チケットがありません。本編の受付は明日からです" });
  });

  it("拒否: 所持が必須のイベントが複数あれば、すべてを持たなければならない", () => {
    const reception: Reception = { ...eveReception, require: [EVE, MAIN] };
    const eve = ticket({ eventId: EVE, userName: "alice" });
    expect(run({ tickets: [eve] }, qr(eve), reception).kind).toBe("rejected");
  });

  it("拒否: ほかのユーザのチケットでは、所持が必須の条件を満たさない", () => {
    const main = ticket({ eventId: MAIN, userName: "alice" });
    const eve = ticket({ eventId: EVE, userName: "bob" });
    expect(run({ tickets: [main, eve] }, qr(main), eveReception).kind).toBe("rejected");
  });

  it("チケットなし: 所持が必須の条件を満たすが、チェックインするイベントのチケットを持たない（FR-16）", () => {
    const reception: Reception = { ...partyReception, accept: [MAIN, PARTY], require: [MAIN], checkin: [PARTY] };
    const main = ticket({ eventId: MAIN, userName: "alice" });
    const result = run({ tickets: [main] }, qr(main), reception);
    expect(result).toMatchObject({ kind: "noTicketToCheckIn", checkInEvents: [PARTY] });
  });

  it("所持が必須のイベントがない受付は、どのユーザも条件を満たす", () => {
    const reception: Reception = { ...mainReception, require: [] };
    const main = ticket({ eventId: MAIN, userName: "alice" });
    expect(run({ tickets: [main] }, qr(main), reception).kind).toBe("success");
  });
});

describe("判定: 検索からのチェックイン（FR-26）", () => {
  const search = (...tickets: Ticket[]): JudgeInput => ({ kind: "search", tickets });

  it("成功: イベントごとに選んだチケットを、読み取ったチケットとみなして済みにする", () => {
    const eve = ticket({ eventId: EVE, userName: "alice" });
    const main1 = ticket({ eventId: MAIN, userName: "alice" });
    const main2 = ticket({ eventId: MAIN, userName: "alice" });
    const result = run({ tickets: [eve, main1, main2] }, search(eve, main2), eveReception);
    expect(result.kind).toBe("success");
    if (result.kind === "success") expect(tokens(result.newlyDone)).toEqual(tokens([main2, eve]));
  });

  it("受け付けるイベントの判定を省くので、切替提案と対象外にならない", () => {
    // 判定の入口の違いを見るために、受け付けないイベントのチケットを渡す。S06 は、こういうチケットを選ばせない
    const main = ticket({ eventId: MAIN, userName: "alice" });
    const party = ticket({ eventId: PARTY, userName: "alice" });
    const result = run({ tickets: [main, party] }, search(main), partyReception);
    expect(result.kind).toBe("success");
    if (result.kind === "success") expect(tokens(result.newlyDone)).toEqual(tokens([party]));
  });

  it("拒否: 所持が必須の判定は行う", () => {
    const main = ticket({ eventId: MAIN, userName: "alice" });
    expect(run({ tickets: [main] }, search(main), eveReception).kind).toBe("rejected");
  });

  it("済み: 選んだチケットがどれも済みなら、最も新しい根拠の記録を返す", () => {
    const eve = ticket({ eventId: EVE, userName: "alice" });
    const main = ticket({ eventId: MAIN, userName: "alice" });
    const records = [checkin(1, eve.ticketToken, 1000), checkin(2, main.ticketToken, 2000)];
    const result = run({ tickets: [eve, main], records }, search(eve, main), eveReception);
    expect(result.kind).toBe("alreadyDone");
    if (result.kind === "alreadyDone") expect(result.basis.recordId).toBe(uuid(2));
  });
});

describe("UserView（Design Doc 5.4）", () => {
  it("そのユーザの有効なチケットと、判定した時点の状態を、チケットの並び順で写す", () => {
    const eve = ticket({ eventId: EVE, userName: "alice", name: "Alice" });
    const main2 = ticket({ eventId: MAIN, userName: "alice", ticketNo: "A-12", name: "アリス" });
    const main1 = ticket({ eventId: MAIN, userName: "alice", ticketNo: "A-2", name: "Alice" });
    const index = buildSnapshotIndex(snapshotsOf([eve, main2, main1]), EVENT_IDS);
    const states = aggregate([checkin(1, main2.ticketToken, 1000)]);

    const view = buildUserView("alice", index, states);
    expect(view.userName).toBe("alice");
    expect(view.name).toBe("Alice、アリス");
    expect(view.tickets.map((t) => [t.ticketNo, t.state.done])).toEqual([
      ["A-2", false],
      ["A-12", true],
      [eve.ticketNo, false],
    ]);
    expect(buildUserView("nobody", index, states)).toEqual({ userName: "nobody", name: "", tickets: [] });
  });

  it("判定の結果の UserView は、記録を作る前の状態を持つ", () => {
    const main = ticket({ eventId: MAIN, userName: "alice" });
    const result = run({ tickets: [main] }, { kind: "qr", ticket: main }, mainReception);
    expect(result.user.tickets[0]?.state).toEqual({ done: false });
  });
});
