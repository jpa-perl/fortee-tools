import { describe, expect, it } from "vitest";
import type { PublishedConfig } from "../../src/core/config.ts";
import type { Ticket } from "../../src/core/snapshot.ts";
import {
  buildTemplateContext,
  checkTemplateNames,
  checkTemplateSubset,
  renderTemplate,
  type TemplateTicketInput,
  validateTemplate,
} from "../../src/core/template.ts";
import { config as baseConfig, EVE, jst, MAIN, PARTY, ticket } from "./helpers.ts";

// 設定のフィクスチャ。アンケートの項目と種別の群を、本編と前夜祭の両方に置く
const config: PublishedConfig = {
  ...baseConfig,
  display: {
    answers: [
      { event: MAIN, field: "Tシャツのサイズ", key: "tshirt" },
      { event: EVE, field: "食事", key: "meal" },
      { event: EVE, field: "備考" },
    ],
    ticketTypes: [
      ...baseConfig.display.ticketTypes,
      { event: EVE, types: ["前夜祭 VIP"], key: "vip" },
      // 本編と同じ key を、前夜祭にも置く。同じイベントの中でなければ、重複してよい
      { event: EVE, types: ["前夜祭スタッフ"], key: "staff" },
    ],
  },
};

const NOW = jst(2026, 11, 28, 12, 0);

const mainTicket = ticket({
  eventId: MAIN,
  userName: "karupanerura",
  ticketNo: "A-12",
  ticketType: "【カンファレンス本編】一般チケット",
  name: "かるぱ",
  answers: { "Tシャツのサイズ": "L", "スピーカー名札に記載するお名前": "" },
});
const eveTicket = ticket({
  eventId: EVE,
  userName: "karupanerura",
  ticketNo: "E-1",
  ticketType: "前夜祭 VIP",
  name: "karupa",
  forteeCheckedIn: true,
  answers: { 食事: "", 備考: "アレルギーあり" },
});

function contextOf(tickets: readonly TemplateTicketInput[], reception: { id: string; name: string } | null = null) {
  return buildTemplateContext({ userName: "karupanerura", tickets, reception, config, now: NOW });
}

const context = contextOf(
  [
    { ticket: mainTicket, done: { at: jst(2026, 11, 27, 18, 5), receptionName: "前夜祭受付" } },
    { ticket: eveTicket, done: null },
  ],
  { id: "main", name: "本編受付" },
);

const render = (template: string, ctx: object = context) => {
  const result = renderTemplate(template, ctx);
  if (!result.ok) throw new Error(result.errors.map((error) => error.message).join("\n"));
  return result.text;
};

const messages = (template: string) => validateTemplate(template, config).map((error) => error.message);

/** チケットのセクションの中に置く */
const inTicket = (body: string) => `{{#byEvent.main}}${body}{{/byEvent.main}}`;

describe("部分集合の検証（Design Doc 4.6）", () => {
  it.each([
    ["変数", "{{user.userName}}"],
    ["{{.}}", "{{#tickets}}{{#ticketNo}}{{.}}{{/ticketNo}}{{/tickets}}"],
    ["セクション", "{{#tickets}}{{ticketNo}}{{/tickets}}"],
    ["反転セクション", "{{^byEvent.main}}なし{{/byEvent.main}}"],
    ["コメント", "{{! コメント }}"],
    ["タグのない文字列", "参考情報はありません"],
    ["空のテンプレート", ""],
    // 継承の記法は、mustache.js が変数として解析するので、部分集合の検証には掛からない。名前の検証が止める
    ["継承の記法", "{{<parent}}{{$block}}"],
  ])("%s を通す", (_name, template) => {
    expect(checkTemplateSubset(template)).toEqual([]);
    expect(renderTemplate(template, context).ok).toBe(true);
  });

  it.each([
    ["エスケープしない変数 {{{", "{{{user.name}}}", "エスケープしない変数"],
    ["エスケープしない変数 {{&", "{{&user.name}}", "エスケープしない変数"],
    ["部分テンプレート", "{{>header}}", "部分テンプレート"],
    ["区切り文字の変更", "{{=<% %>=}}", "区切り文字の変更"],
    ["セクションの中の持たないタグ", "{{#tickets}}{{{ticketNo}}}{{/tickets}}", "エスケープしない変数"],
    ["反転セクションの中の持たないタグ", "{{^tickets}}{{>empty}}{{/tickets}}", "部分テンプレート"],
  ])("%s を止める", (_name, template, message) => {
    const errors = checkTemplateSubset(template);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain(message);
    expect(errors[0]?.position).toBeTypeOf("number");
    // 描画もしない
    expect(renderTemplate(template, context)).toEqual({ ok: false, errors });
  });

  it("持たないタグは、すべて列挙する", () => {
    expect(checkTemplateSubset("{{{a}}}\n{{&b}}\n{{>c}}").map((error) => error.position)).toEqual([0, 8, 15]);
  });

  it.each([
    ["閉じていないセクション", "{{#tickets}}{{ticketNo}}"],
    ["開いていないセクションの終了", "{{ticketNo}}{{/tickets}}"],
    ["対応しないセクション", "{{#tickets}}{{/byEvent.main}}"],
    ["閉じていないタグ", "{{user.name"],
    ["継承の記法に閉じるタグを付ける", "{{<parent}}{{/parent}}"],
  ])("解析の誤り: %s", (_name, template) => {
    const errors = checkTemplateSubset(template);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain("テンプレートを解析できません");
    expect(validateTemplate(template, config)).toEqual(errors);
    expect(checkTemplateNames(template, config)).toEqual(errors);
    expect(renderTemplate(template, context)).toEqual({ ok: false, errors });
  });
});

describe("名前の検証（Design Doc 4.6）", () => {
  // 通るテンプレートは、mustache.js で描画して、期待する文字列になることも確かめる。
  // 検証の形の積み方と、描画の文脈の積み方が食い違わないことを見るためである
  it.each([
    ["最も外側の名前", "{{user.userName}}（{{user.name}}）", "karupanerura（かるぱ、karupa）"],
    ["受付", "{{reception.id}} {{reception.name}}", "main 本編受付"],
    ["受付のセクション", "{{#reception}}{{name}}{{/reception}}{{^reception}}受付なし{{/reception}}", "本編受付"],
    ["チケットの一覧", "{{#tickets}}[{{eventKey}} {{eventName}} {{ticketNo}} {{name}}]{{/tickets}}", "[main 本編 A-12 かるぱ][eve 前夜祭 E-1 karupa]"],
    ["イベントごと", inTicket("{{ticketNo}} {{ticketType}}"), "A-12 【カンファレンス本編】一般チケット"],
    ["イベントの id では引けず、key で引く", "{{#byEvent.eve}}{{ticketNo}}{{/byEvent.eve}}", "E-1"],
    ["チケットを持たないイベントの反転セクション", "{{^byEvent.party}}懇親会なし{{/byEvent.party}}", "懇親会なし"],
    ["真偽値の変数", inTicket("{{done}} {{forteeCheckedIn}}"), "true false"],
    ["真偽値のセクションの中の名前は、外側のチケットの形で解決する", inTicket("{{#done}}{{doneAt}} {{doneReception}}{{/done}}"), "11/27 18:05 前夜祭受付"],
    ["反転セクションの中の名前も、外側のチケットの形で解決する", "{{#byEvent.eve}}{{^done}}未 {{ticketNo}}{{/done}}{{/byEvent.eve}}", "未 E-1"],
    ["種別の群", inTicket("{{#typeIs.general}}一般{{/typeIs.general}}{{#typeIs.staff}}スタッフ{{/typeIs.staff}}{{^typeIs.vip}}VIP でない{{/typeIs.vip}}"), "一般VIP でない"],
    ["回答の変数", inTicket("{{answers.tshirt}}"), "L"],
    ["文字列のセクションの中の {{.}}", inTicket("{{#answers.tshirt}}{{.}}{{/answers.tshirt}}"), "L"],
    ["文字列のセクションの中の名前は、その外側の形で解決する", inTicket("{{#answers.tshirt}}{{ticketNo}}{{/answers.tshirt}}"), "A-12"],
    ["key を省いた項目は、field で参照する", "{{#byEvent.eve}}{{answers.備考}}{{/byEvent.eve}}", "アレルギーあり"],
    ["ほかのイベントの key は空文字", inTicket("[{{answers.meal}}]{{^answers.meal}}なし{{/answers.meal}}"), "[]なし"],
    ["セクションの中から、外側の名前を引く", inTicket("{{user.userName}} {{reception.name}}"), "karupanerura 本編受付"],
    ["オブジェクトのセクション", "{{#user}}{{userName}}{{/user}}", "karupanerura"],
    ["入れ子のオブジェクトのセクション", inTicket("{{#answers}}{{tshirt}}{{/answers}}{{#typeIs}}{{general}}{{/typeIs}}"), "Ltrue"],
    ["コメントの中の名前は見ない", "{{! user.unknown は使えない }}ok", "ok"],
  ])("通る: %s", (_name, template, expected) => {
    expect(messages(template)).toEqual([]);
    expect(render(template)).toBe(expected);
  });

  it.each([
    ["オブジェクトを指す変数", "{{user}}", "値ではありません"],
    ["配列を指す変数", "{{tickets}}", "値ではありません"],
    ["オブジェクトを指す変数（チケットの中）", inTicket("{{answers}}"), "値ではありません"],
    ["打ち間違えた key", inTicket("{{answers.tshrit}}"), "参照できる名前ではありません"],
    ["未知の種別の群", inTicket("{{#typeIs.speaker}}x{{/typeIs.speaker}}"), "参照できる名前ではありません"],
    ["未知のイベント", "{{#byEvent.workshop}}x{{/byEvent.workshop}}", "参照できる名前ではありません"],
    ["イベントの key があるのに id で引く", `{{#byEvent.${MAIN}}}x{{/byEvent.${MAIN}}}`, "参照できる名前ではありません"],
    ["prototype の名前", "{{constructor}}", "参照できる名前ではありません"],
    ["prototype の名前（チケットの中）", inTicket("{{answers.toString}}"), "参照できる名前ではありません"],
    ["__proto__", "{{__proto__}}", "参照できる名前ではありません"],
    ["継承の記法（親）", "{{<x}}", "参照できる名前ではありません"],
    ["継承の記法（ブロック）", "{{$x}}", "参照できる名前ではありません"],
    ["空白を含む名前", "{{a b}}", "参照できる名前ではありません"],
    ["チケットの名前を、チケットのセクションの外で使う", "{{ticketNo}}", "参照できる名前ではありません"],
    ["文字列の先の名前", "{{user.name.length}}", "参照できる名前ではありません"],
    ["最も外側の {{.}}", "{{.}}", "値ではありません"],
    ["チケットのセクションの中の {{.}}", inTicket("{{.}}"), "値ではありません"],
    ["真偽値のセクションの中の {{.}}", inTicket("{{#done}}{{.}}{{/done}}"), "値ではありません"],
    ["反転セクションの中の {{.}}", inTicket("{{^typeIs.staff}}{{.}}{{/typeIs.staff}}"), "値ではありません"],
    ["反転セクションの中の、チケットにない名前", inTicket("{{^done}}{{userName}}{{/done}}"), "参照できる名前ではありません"],
    ["未知の名前のセクション", "{{#unknown}}x{{/unknown}}", "参照できる名前ではありません"],
    ["未知の名前の反転セクション", "{{^unknown}}x{{/unknown}}", "参照できる名前ではありません"],
  ])("止まる: %s", (_name, template, message) => {
    const errors = messages(template);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain(message);
  });

  it("イベントに key がなければ、id で引く", () => {
    const withoutKey = { ...config, events: [{ id: MAIN, name: "本編" }] };
    const template = `{{#byEvent.${MAIN}}}{{ticketNo}}{{/byEvent.${MAIN}}}`;
    expect(validateTemplate(template, withoutKey)).toEqual([]);
    expect(validateTemplate("{{#byEvent.main}}x{{/byEvent.main}}", withoutKey)).toHaveLength(1);
    const ctx = buildTemplateContext({
      userName: "karupanerura",
      tickets: [{ ticket: mainTicket, done: null }],
      reception: null,
      config: withoutKey,
      now: NOW,
    });
    expect(render(template, ctx)).toBe("A-12");
  });

  it("名前の誤りは、位置の順にすべて列挙する。部分集合の誤りも合わせて返す", () => {
    const template = "{{user}}\n{{{user.name}}}\n{{#byEvent.main}}{{answers.tshrit}}{{/byEvent.main}}\n{{#unknown}}{{constructor}}{{/unknown}}";
    const errors = validateTemplate(template, config);
    expect(errors.map((error) => error.message)).toEqual([
      "{{user}} は値ではありません。変数のタグは、文字列か真偽値を指す名前に使います",
      "エスケープしない変数（{{{name}}}、{{&name}}）は使えません: user.name",
      "{{answers.tshrit}} は、テンプレートから参照できる名前ではありません",
      "{{#unknown}} は、テンプレートから参照できる名前ではありません",
    ]);
    expect(errors.map((error) => error.position)).toEqual([0, 9, 42, 78]);
    // 名前の検証だけでは、部分集合の誤りを返さない
    expect(checkTemplateNames(template, config)).toHaveLength(3);
  });

  it("名前を解決できないセクションの中は確かめない。派生した誤りを並べないためである", () => {
    // byEvent.mian を直せば、中の {{ticketNo}} は通り、{{answers.tshrit}} は止まる
    expect(messages("{{#byEvent.mian}}{{ticketNo}} {{answers.tshrit}}{{/byEvent.mian}}")).toEqual([
      "{{#byEvent.mian}} は、テンプレートから参照できる名前ではありません",
    ]);
    // 反転セクションは何も積まないので、名前を解決できなくても、中を確かめる
    expect(messages("{{^byEvent.mian}}{{user.nmae}}{{/byEvent.mian}}")).toEqual([
      "{{^byEvent.mian}} は、テンプレートから参照できる名前ではありません",
      "{{user.nmae}} は、テンプレートから参照できる名前ではありません",
    ]);
    expect(messages("{{#byEvent.main}}{{ticketNo}} {{answers.tshrit}}{{/byEvent.main}}")).toEqual([
      "{{answers.tshrit}} は、テンプレートから参照できる名前ではありません",
    ]);
  });

  it("描画は名前の検証を行わない。文脈にない名前は空文字になる（Design Doc 9.6）", () => {
    expect(render("[{{addedInNewRelease}}][{{user.unknown}}]{{#unknown}}x{{/unknown}}")).toBe("[][]");
  });
});

describe("描画（Design Doc 4.6、FR-20）", () => {
  it("エスケープしない。参加者が入力した値を、そのままの文字列で出す", () => {
    const html = ticket({ eventId: MAIN, userName: "<b>&\"'/`=</b>", name: "<script>alert(1)</script>" });
    const ctx = buildTemplateContext({
      userName: html.userName,
      tickets: [{ ticket: html, done: null }],
      reception: null,
      config,
      now: NOW,
    });
    expect(render("{{user.userName}} {{user.name}}", ctx)).toBe("<b>&\"'/`=</b> <script>alert(1)</script>");
  });

  it("値の中の Mustache の記法は、解釈しない", () => {
    const tricky = ticket({ eventId: MAIN, userName: "{{user.name}}", name: "{{{x}}}" });
    const ctx = buildTemplateContext({
      userName: tricky.userName,
      tickets: [{ ticket: tricky, done: null }],
      reception: null,
      config,
      now: NOW,
    });
    expect(render("{{user.userName}}|{{user.name}}", ctx)).toBe("{{user.name}}|{{{x}}}");
  });

  it("改行を保ち、セクションだけの行は行ごと取り除く。変数だけの行は取り除かない", () => {
    const template = "1 行目\n{{#byEvent.main}}\n{{ticketNo}}\n{{/byEvent.main}}\n{{! コメント }}\n{{user.userName}}\n最後\n";
    expect(render(template)).toBe("1 行目\nA-12\nkarupanerura\n最後\n");
  });

  it("Design Doc 4.2 の例のテンプレートを描画する", () => {
    const template = [
      "{{user.userName}} さん",
      "{{#byEvent.main}}",
      "本編 {{ticketNo}} {{ticketType}}{{#done}}（済 {{doneAt}}）{{/done}}",
      "{{#typeIs.general}}ネームカード: 一般。Tシャツあり{{/typeIs.general}}",
      "{{#typeIs.staff}}ネームカード: スタッフ。Tシャツはスタッフ控室で{{/typeIs.staff}}",
      "{{#answers.tshirt}}Tシャツ: {{answers.tshirt}}{{/answers.tshirt}}",
      "{{/byEvent.main}}",
      "{{^byEvent.main}}",
      "本編チケットなし",
      "{{/byEvent.main}}",
      "",
    ].join("\n");
    expect(validateTemplate(template, config)).toEqual([]);
    expect(render(template)).toBe(
      "karupanerura さん\n本編 A-12 【カンファレンス本編】一般チケット（済 11/27 18:05）\nネームカード: 一般。Tシャツあり\n\nTシャツ: L\n",
    );
    expect(render(template, contextOf([{ ticket: eveTicket, done: null }]))).toBe("karupanerura さん\n本編チケットなし\n");
  });
});

describe("文脈の組み立て（Design Doc 4.6）", () => {
  it("ユーザ、受付、チケットの一覧、イベントごとのチケットを持つ", () => {
    expect(context.user).toEqual({ userName: "karupanerura", name: "かるぱ、karupa" });
    expect(context.reception).toEqual({ id: "main", name: "本編受付" });
    expect(context.tickets.map((t) => t.ticketNo)).toEqual(["A-12", "E-1"]);
    expect(Object.keys(context.byEvent)).toEqual(["main", "eve"]);
    expect(context.byEvent.main).toEqual([context.tickets[0]]);
    expect(context.byEvent.eve).toEqual([context.tickets[1]]);
  });

  it("チケットの値と状態を写す", () => {
    expect(context.tickets[0]).toEqual({
      eventKey: "main",
      eventName: "本編",
      ticketNo: "A-12",
      ticketType: "【カンファレンス本編】一般チケット",
      name: "かるぱ",
      typeIs: { general: true, staff: false, vip: false },
      done: true,
      doneAt: "11/27 18:05",
      doneReception: "前夜祭受付",
      forteeCheckedIn: false,
      answers: { tshirt: "L", meal: "", 備考: "" },
    });
    expect(context.tickets[1]).toEqual({
      eventKey: "eve",
      eventName: "前夜祭",
      ticketNo: "E-1",
      ticketType: "前夜祭 VIP",
      name: "karupa",
      typeIs: { general: false, staff: false, vip: true },
      done: false,
      doneAt: "",
      doneReception: "",
      forteeCheckedIn: true,
      answers: { tshirt: "", meal: "", 備考: "アレルギーあり" },
    });
  });

  it("済みの時刻は、当日なら時と分だけにする（画面設計書 2.9）", () => {
    const ctx = contextOf([{ ticket: mainTicket, done: { at: jst(2026, 11, 28, 9, 31), receptionName: "本編受付" } }]);
    expect(ctx.tickets[0]?.doneAt).toBe("09:31");
  });

  it("受付なしのときは、reception を持たない（FR-20）", () => {
    const ctx = contextOf([{ ticket: mainTicket, done: null }]);
    expect("reception" in ctx).toBe(false);
    expect(render("{{^reception}}受付なし{{/reception}}{{reception.name}}", ctx)).toBe("受付なし");
  });

  it("チケットを持たないイベントのキーは、byEvent に置かない", () => {
    expect("party" in context.byEvent).toBe(false);
    expect(render("{{^byEvent.party}}懇親会チケットなし{{/byEvent.party}}")).toBe("懇親会チケットなし");
  });

  it("同じイベントのチケットは、渡された順に byEvent に並ぶ", () => {
    const second = { ...mainTicket, ticketToken: "S".repeat(32), ticketNo: "A-13" };
    const ctx = contextOf([
      { ticket: mainTicket, done: null },
      { ticket: second, done: null },
    ]);
    expect(render("{{#byEvent.main}}{{ticketNo}} {{/byEvent.main}}", ctx)).toBe("A-12 A-13 ");
  });

  it("全イベントの key の和集合を、すべてのチケットの answers と typeIs に置く", () => {
    for (const t of context.tickets) {
      expect(Object.keys(t.answers).sort()).toEqual(["meal", "tshirt", "備考"]);
      expect(Object.keys(t.typeIs).sort()).toEqual(["general", "staff", "vip"]);
    }
  });

  it("typeIs は、そのチケットのイベントの群だけを見る。ほかのイベントの同じ key では true にならない", () => {
    const eveStaff: Ticket = { ...eveTicket, ticketType: "【カンファレンス本編】スタッフチケット" };
    expect(contextOf([{ ticket: eveStaff, done: null }]).tickets[0]?.typeIs).toEqual({ general: false, staff: false, vip: false });
    const realEveStaff: Ticket = { ...eveTicket, ticketType: "前夜祭スタッフ" };
    expect(contextOf([{ ticket: realEveStaff, done: null }]).tickets[0]?.typeIs).toEqual({ general: false, staff: true, vip: false });
  });

  it("answers は、そのチケットのイベントの項目だけを見る。同じ項目名がほかのイベントの回答にあっても出さない", () => {
    const partyTicket = ticket({ eventId: PARTY, userName: "karupanerura", answers: { "Tシャツのサイズ": "XL" } });
    expect(contextOf([{ ticket: partyTicket, done: null }]).tickets[0]?.answers).toEqual({ tshirt: "", meal: "", 備考: "" });
  });

  it("入れ子のセクションで、外側のチケットの値が出ない", () => {
    // mustache.js は、欠けた名前を外側の文脈で探し直す。和集合を置かなければ、前夜祭のチケットの中で、
    // 本編のチケットの回答（L）と種別（general）が出る
    const template =
      "{{#byEvent.main}}{{#byEvent.eve}}[{{answers.tshirt}}]{{#typeIs.general}}一般{{/typeIs.general}}{{#answers.tshirt}}{{.}}{{/answers.tshirt}}{{/byEvent.eve}}{{/byEvent.main}}";
    expect(messages(template)).toEqual([]);
    expect(render(template)).toBe("[]");
  });

  it("設定の key が prototype の名前でも、ただの鍵として持つ", () => {
    const odd: PublishedConfig = {
      ...config,
      events: [{ id: MAIN, name: "本編", key: "__proto__" }],
      display: {
        answers: [{ event: MAIN, field: "Tシャツのサイズ", key: "constructor" }],
        ticketTypes: [{ event: MAIN, types: ["【カンファレンス本編】一般チケット"], key: "__proto__" }],
      },
    };
    const template = "{{#byEvent.__proto__}}{{answers.constructor}} {{typeIs.__proto__}}{{/byEvent.__proto__}}";
    expect(validateTemplate(template, odd)).toEqual([]);
    const ctx = buildTemplateContext({
      userName: "karupanerura",
      tickets: [{ ticket: mainTicket, done: null }],
      reception: null,
      config: odd,
      now: NOW,
    });
    expect(render(template, ctx)).toBe("L true");
  });
});
