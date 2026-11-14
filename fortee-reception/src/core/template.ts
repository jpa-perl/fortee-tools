import Mustache from "mustache";
import { answerKeyOf, eventKeyOf, type PublishedConfig } from "./config.ts";
import { combineNames, type Ticket } from "./snapshot.ts";
import { formatTime } from "./time.ts";

// 参考情報テンプレート（Design Doc 4.6、FR-20, 46）。
//
// 形式は、Mustache のうち変数（{{.}} を含む）、セクション、反転セクション、コメントだけを持つ部分集合で、
// 描画は mustache.js を呼ぶ 1 つの関数（renderTemplate）に閉じる。
//
// 描画結果は HTML である。テンプレートに書いた HTML はそのまま出し、変数の値（参加者が入力した値を含む）は
// mustache.js の既定のエスケープを通す。エスケープしない変数は部分集合にないので、値がタグになることはない。
//
// - 部分集合の検証: 受付アプリと CLI の両方が行う
// - 名前の検証: CLI の validate と publish だけが行う。受付アプリでは行わない（Design Doc 4.6、9.6）

/** テンプレートの区切り文字。mustache.js の全体の設定（Mustache.tags）によらないように、呼ぶたびに渡す */
const TAGS: [string, string] = ["{{", "}}"];

/** テンプレートの誤り。position は、テンプレートの中の位置（符号単位の数。先頭は 0） */
export type TemplateError = { message: string; position?: number };

/** テンプレートに渡す文脈（Design Doc 4.6） */
export type TemplateContext = {
  /** name はチケットの Name をまとめた値（Design Doc 4.3） */
  user: { userName: string; name: string };
  /** 現在の受付。受付なしのときは持たない（FR-20） */
  reception?: {
    id: string;
    name: string;
    /** 設定の受付の id のすべて。現在の受付の id だけが true */
    is: Record<string, boolean>;
    /** 設定のイベントの key（なければ id）のすべて。現在の受付がチェックインするイベント（FR-2）が true */
    checkin: Record<string, boolean>;
  };
  /** そのユーザの有効なチケットすべて。チケットの並び順 */
  tickets: TemplateTicket[];
  /** イベントの key（なければ id）ごと。チケットを持たないイベントのキーは持たない */
  byEvent: Record<string, TemplateTicket[]>;
};

export type TemplateTicket = {
  eventKey: string;
  eventName: string;
  ticketNo: string;
  ticketType: string;
  /** このチケットの Name（CSV のその行の値） */
  name: string;
  /** 設定の display.ticketTypes の key のすべて（全イベントの和集合）。この券の種別を types に含む key が true */
  typeIs: Record<string, boolean>;
  /** 本システムの記録で済みか（PRD 7.2） */
  done: boolean;
  /** 済みなら画面設計書 2.9 の書式の時刻、未なら空文字 */
  doneAt: string;
  /** 済みにした受付の表示名。未なら空文字 */
  doneReception: string;
  forteeCheckedIn: boolean;
  /** 設定の display.answers の key（省略時は field）のすべて（全イベントの和集合）→ 回答。値がなければ空文字 */
  answers: Record<string, string>;
};

// mustache.js の parse が返すトークン。[種別, 値, 開始, 終了, 子のトークン（セクションだけ）, ...]
type Token = [type: string, value: string, start: number, end: number, children?: Token[]];

type ParseResult = { ok: true; tokens: Token[] } | { ok: false; error: TemplateError };

function parse(template: string): ParseResult {
  try {
    return { ok: true, tokens: Mustache.parse(template, TAGS) as unknown as Token[] };
  } catch (error) {
    // mustache.js は、対応しないセクションや閉じていないタグを、最初の 1 件だけ例外で知らせる
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, error: { message: `テンプレートを解析できません: ${detail}` } };
  }
}

const FORBIDDEN_TAGS: Record<string, string> = {
  "&": "エスケープしない変数（{{{name}}}、{{&name}}）は使えません",
  ">": "部分テンプレート（{{>name}}）は使えません",
  "=": "区切り文字の変更（{{=<% %>=}}）は使えません",
};

function collectForbidden(tokens: Token[], errors: TemplateError[]): void {
  for (const token of tokens) {
    const [type, value, start, , children] = token;
    const message = FORBIDDEN_TAGS[type];
    if (message !== undefined) errors.push({ message: `${message}: ${value}`, position: start });
    if ((type === "#" || type === "^") && children !== undefined) collectForbidden(children, errors);
  }
}

/**
 * 部分集合の検証（Design Doc 4.6）。mustache.js で解析でき、持たないタグ
 * （{{{、{{&、{{>、{{=）がないことを確かめる。誤りがなければ空の配列を返す。
 * 解析の誤りは最初の 1 件だけ、持たないタグはすべて返す
 */
export function checkTemplateSubset(template: string): TemplateError[] {
  const parsed = parse(template);
  if (!parsed.ok) return [parsed.error];
  const errors: TemplateError[] = [];
  collectForbidden(parsed.tokens, errors);
  return errors;
}

// 名前の検証に使う、文脈の形

type Shape =
  | { kind: "string" }
  | { kind: "boolean" }
  | { kind: "object"; fields: Map<string, Shape> }
  | { kind: "array"; item: Shape };

const STRING: Shape = { kind: "string" };
const BOOLEAN: Shape = { kind: "boolean" };
const object = (fields: Iterable<[string, Shape]>): Shape => ({ kind: "object", fields: new Map(fields) });
const fixed = (fields: Record<string, Shape>): Shape => object(Object.entries(fields));

/** 名前の検証と文脈の組み立てが読む設定。公開する設定も、設定検証の途中の値も渡せる */
export type TemplateConfig = {
  events: readonly { id: string; name: string; key?: string | undefined }[];
  /** checkin は、イベントの id か key。公開する設定では id に解決済みで、設定検証の途中では書かれたままの値である */
  receptions: readonly { id: string; checkin: readonly string[] }[];
  display: {
    answers: readonly { event: string; field: string; key?: string | undefined }[];
    ticketTypes: readonly { event: string; types: readonly string[]; key: string }[];
  };
};

function rootShape(config: TemplateConfig): Shape {
  const ticket = fixed({
    eventKey: STRING,
    eventName: STRING,
    ticketNo: STRING,
    ticketType: STRING,
    name: STRING,
    typeIs: object(config.display.ticketTypes.map((group): [string, Shape] => [group.key, BOOLEAN])),
    done: BOOLEAN,
    doneAt: STRING,
    doneReception: STRING,
    forteeCheckedIn: BOOLEAN,
    answers: object(config.display.answers.map((answer): [string, Shape] => [answerKeyOf(answer), STRING])),
  });
  const tickets: Shape = { kind: "array", item: ticket };
  return fixed({
    user: fixed({ userName: STRING, name: STRING }),
    reception: fixed({
      id: STRING,
      name: STRING,
      is: object(config.receptions.map((reception): [string, Shape] => [reception.id, BOOLEAN])),
      checkin: object(config.events.map((event): [string, Shape] => [eventKeyOf(event), BOOLEAN])),
    }),
    tickets,
    byEvent: object(config.events.map((event): [string, Shape] => [eventKeyOf(event), tickets])),
  });
}

/** 名前を、形の積み重ねの上から順に探す。mustache.js と同じく、途中で欠ければ外側で探し直す */
function resolve(name: string, stack: Shape[]): Shape | null {
  if (name === ".") return stack[stack.length - 1] ?? null;
  const names = name.split(".");
  for (let i = stack.length - 1; i >= 0; i--) {
    let shape: Shape | undefined = stack[i];
    for (const part of names) {
      shape = shape?.kind === "object" ? shape.fields.get(part) : undefined;
      if (shape === undefined) break;
    }
    if (shape !== undefined) return shape;
  }
  return null;
}

function checkNames(tokens: Token[], stack: Shape[], errors: TemplateError[]): void {
  for (const token of tokens) {
    const [type, name, start, , children] = token;
    if (type === "name") {
      const shape = resolve(name, stack);
      if (shape === null) {
        errors.push({ message: `{{${name}}} は、テンプレートから参照できる名前ではありません`, position: start });
      } else if (shape.kind !== "string" && shape.kind !== "boolean") {
        errors.push({
          message: `{{${name}}} は値ではありません。変数のタグは、文字列か真偽値を指す名前に使います`,
          position: start,
        });
      }
    } else if (type === "#" || type === "^") {
      const shape = resolve(name, stack);
      if (shape === null) {
        errors.push({
          message: `{{${type}${name}}} は、テンプレートから参照できる名前ではありません`,
          position: start,
        });
        // セクションの中の名前は確かめない。何を積むかが決まらないので、確かめると、この誤りから派生した誤りが並ぶ。
        // 反転セクションは何も積まないので、中も確かめる
        if (type === "^") checkNames(children ?? [], stack, errors);
      } else if (type === "^" || shape.kind === "boolean") {
        // 反転セクションと、真偽値のセクションは、文脈を変えない
        checkNames(children ?? [], stack, errors);
      } else {
        checkNames(children ?? [], [...stack, shape.kind === "array" ? shape.item : shape], errors);
      }
    }
  }
}

/**
 * 名前の検証（Design Doc 4.6）。テンプレートの各タグの名前が、設定から決まる文脈の形で解決できることを確かめる。
 * 誤りをすべて返し、なければ空の配列を返す。解析できないテンプレートでは、解析の誤り 1 件を返す。
 * 名前を解決できないセクション（{{#name}}）の中は確かめない（そのセクションの名前を直すと、中の誤りが出る）。
 * 部分集合にないタグは見ない（checkTemplateSubset が止める）
 */
export function checkTemplateNames(template: string, config: TemplateConfig): TemplateError[] {
  const parsed = parse(template);
  if (!parsed.ok) return [parsed.error];
  const errors: TemplateError[] = [];
  checkNames(parsed.tokens, [rootShape(config)], errors);
  return errors;
}

/**
 * 設定検証（FR-4）と公開の前に行う、テンプレートの検証。部分集合の検証と名前の検証の誤りを、位置の順に返す。
 * 解析できないテンプレートでは、解析の誤り 1 件を返す
 */
export function validateTemplate(template: string, config: TemplateConfig): TemplateError[] {
  const parsed = parse(template);
  if (!parsed.ok) return [parsed.error];
  const errors: TemplateError[] = [];
  collectForbidden(parsed.tokens, errors);
  checkNames(parsed.tokens, [rootShape(config)], errors);
  return errors.sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
}

/** html は、HTML として表示する文字列。変数の値はエスケープ済みである */
export type RenderResult = { ok: true; html: string } | { ok: false; errors: TemplateError[] };

/**
 * テンプレートを HTML に描画する（Design Doc 4.6、FR-20）。部分集合の検証を通らないテンプレートは、描画せずに誤りを返す。
 * 名前の検証は行わない。文脈にない名前は、空文字になる。
 * 変数の値は、mustache.js の既定のエスケープ（& < > " ' / ` =）を通す
 */
export function renderTemplate(template: string, context: object): RenderResult {
  const errors = checkTemplateSubset(template);
  if (errors.length > 0) return { ok: false, errors };
  try {
    return { ok: true, html: Mustache.render(template, context, {}, { tags: TAGS }) };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, errors: [{ message: `テンプレートを描画できません: ${detail}` }] };
  }
}

/** テンプレートに渡すチケットと、その状態。状態は呼び出し側が決める */
export type TemplateTicketInput = {
  ticket: Ticket;
  /** 済みなら、済みの時刻（エポックミリ秒）と、済みにした受付の表示名。未なら null */
  done: { at: number; receptionName: string } | null;
};

export type BuildTemplateContextInput = {
  userName: string;
  /** そのユーザの有効なチケットすべて。チケットの並び順（索引の byUser、UserView の tickets の順）で渡す */
  tickets: readonly TemplateTicketInput[];
  /** 現在の受付。受付なしのときは null */
  reception: { id: string; name: string } | null;
  config: TemplateConfig & { conference: Pick<PublishedConfig["conference"], "timezone"> };
  /** 現在時刻。doneAt の書式（当日かどうか）に使う */
  now: number;
};

/** 設定の key を鍵にする入れ物。key が `__proto__` などでも、ただの鍵として持てるように、prototype を持たせない */
const emptyRecord = <T>(): Record<string, T> => Object.create(null) as Record<string, T>;

/**
 * テンプレートに渡す文脈を作る（Design Doc 4.6）。受付アプリの S04-M1 と、CLI のプレビューが、同じこの関数を使う。
 * チケットの状態は自分では求めず、引数で受ける。
 *
 * すべてのチケットの answers と typeIs には、全イベントの設定の key の和集合を置く。mustache.js が、
 * 欠けた名前を外側の文脈で探し直して、別のチケットの値を出すのを防ぐためである
 */
export function buildTemplateContext(input: BuildTemplateContextInput): TemplateContext {
  const { config } = input;
  const events = new Map(config.events.map((event) => [event.id, event]));

  const tickets = input.tickets.map(({ ticket, done }): TemplateTicket => {
    const event = events.get(ticket.eventId);

    const typeIs = emptyRecord<boolean>();
    for (const group of config.display.ticketTypes) typeIs[group.key] = false;
    for (const group of config.display.ticketTypes) {
      if (group.event === ticket.eventId && group.types.includes(ticket.ticketType)) typeIs[group.key] = true;
    }

    const answers = emptyRecord<string>();
    for (const answer of config.display.answers) answers[answerKeyOf(answer)] = "";
    for (const answer of config.display.answers) {
      if (answer.event === ticket.eventId) answers[answerKeyOf(answer)] = ticket.answers[answer.field] ?? "";
    }

    return {
      eventKey: event === undefined ? ticket.eventId : eventKeyOf(event),
      eventName: event?.name ?? ticket.eventId,
      ticketNo: ticket.ticketNo,
      ticketType: ticket.ticketType,
      name: ticket.name,
      typeIs,
      done: done !== null,
      doneAt: done === null ? "" : formatTime(done.at, input.now, config.conference.timezone),
      doneReception: done?.receptionName ?? "",
      forteeCheckedIn: ticket.forteeCheckedIn,
      answers,
    };
  });

  const byEvent = emptyRecord<TemplateTicket[]>();
  for (const ticket of tickets) (byEvent[ticket.eventKey] ??= []).push(ticket);

  const context: TemplateContext = {
    user: { userName: input.userName, name: combineNames(input.tickets.map(({ ticket }) => ticket)) },
    tickets,
    byEvent,
  };
  if (input.reception !== null) {
    const { id, name } = input.reception;
    // すべての受付の id とイベントの key を false で置いてから、当てはまるものを true にする。
    // 名前の検証が通す名前を、必ず文脈に持たせるためである
    const is = emptyRecord<boolean>();
    for (const reception of config.receptions) is[reception.id] = false;
    is[id] = true;
    const checkin = emptyRecord<boolean>();
    for (const event of config.events) checkin[eventKeyOf(event)] = false;
    const current = config.receptions.find((reception) => reception.id === id);
    for (const ref of current?.checkin ?? []) {
      const event = config.events.find((candidate) => candidate.id === ref || candidate.key === ref);
      if (event !== undefined) checkin[eventKeyOf(event)] = true;
    }
    context.reception = { id, name, is, checkin };
  }
  return context;
}
