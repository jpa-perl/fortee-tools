import type { Reception } from "./config.ts";
import type { CheckinRecord } from "./record.ts";
import { compareRecords, stateOf, type TicketState } from "./records.ts";
import { type ReceptionsConfig, suggestSwitch } from "./reception.ts";
import { combineNames, type SnapshotIndex, type Ticket } from "./snapshot.ts";

// QR の文字列の検証と、判定（Design Doc 5.4、FR-11〜17、画面設計書 2.4）。
//
// 判定は記録を作らない。newlyDone から記録を作るのは、呼び出し側（records.ts の createCheckinRecords）である。

/** チケット QR の形。`fortee:` に、英数字 32 文字のチケットトークンが続く 39 文字（FR-11） */
export const TICKET_QR_PATTERN = /^fortee:([A-Za-z0-9]{32})$/;

/**
 * 読み取った文字列がチケット QR の形なら、チケットトークンを返す。形式外（URL 形式の QR など）は null。
 * QR の文字列から使うのは、このトークンだけである（FR-18）
 */
export function parseTicketQr(text: string): string | null {
  return TICKET_QR_PATTERN.exec(text)?.[1] ?? null;
}

export type JudgeInput =
  /** QR の形式の検証と、索引の引き当ては、呼び出し側で済ませる */
  | { kind: "qr"; ticket: Ticket }
  /** S06 でイベントごとに選んだチケット。同じユーザのチケットを 1 枚以上 */
  | { kind: "search"; tickets: Ticket[] };

export type UserView = {
  userName: string;
  /** チケットの Name をまとめた値（Design Doc 4.3） */
  name: string;
  /** そのユーザの有効なチケットと、判定した時点の状態。チケットの並び順 */
  tickets: (Ticket & { state: TicketState })[];
};

export type Judgement =
  /** 切替提案（FR-9） */
  | { kind: "suggestSwitch"; user: UserView; reception: Reception; outOfPeriod: boolean }
  /** 対象外（FR-10） */
  | { kind: "outOfScope"; user: UserView }
  /** 拒否（FR-14）。message は受付の拒否メッセージ */
  | { kind: "rejected"; user: UserView; message: string }
  /** チケットなし（FR-16）。checkInEvents は、受付の checkin のイベント ID */
  | { kind: "noTicketToCheckIn"; user: UserView; checkInEvents: string[] }
  /** 続けて読み取り（FR-15）。remainingEvents は、チケットを 1 枚指定する必要があるイベントの ID */
  | { kind: "continue"; user: UserView; newlyDone: Ticket[]; remainingEvents: string[] }
  /** 成功（FR-13） */
  | { kind: "success"; user: UserView; newlyDone: Ticket[] }
  /** 済み（FR-16）。basis は、checkin のイベントにあるユーザの済みのチケットの根拠の記録のうち、最も新しいもの */
  | { kind: "alreadyDone"; user: UserView; basis: CheckinRecord };

/** 切替提案（FR-9）を求めるのに使う値。QR の読み取りでだけ使う */
export type JudgeContext = {
  /** 受付の一覧を持つ設定 */
  config: ReceptionsConfig;
  /** 現在時刻 */
  now: number;
};

/**
 * ユーザのチケットと、その時点の状態を写す（Design Doc 5.4）。
 * S06 など、判定の外でユーザのチケットの一覧を出すところでも使える。索引にないユーザは、チケットを持たない
 */
export function buildUserView(
  userName: string,
  index: SnapshotIndex,
  states: ReadonlyMap<string, TicketState>,
): UserView {
  const tickets = index.byUser.get(userName) ?? [];
  return {
    userName,
    name: combineNames(tickets),
    tickets: tickets.map((ticket) => ({ ...ticket, state: stateOf(states, ticket.ticketToken) })),
  };
}

/**
 * 判定（Design Doc 5.4）。画面設計書 2.4 の順に見て、最初に当てはまった結果を返す。
 *
 * QR の読み取りと検索からのチェックインの両方で使う。検索からは、受け付けるイベントの判定（切替提案、対象外）を省く（FR-26）。
 * 受付なしのときは呼ばない。states は、判定する時点の集約（records.ts の aggregate）である
 */
export function judge(
  input: JudgeInput,
  reception: Reception,
  index: SnapshotIndex,
  states: ReadonlyMap<string, TicketState>,
  context: JudgeContext,
): Judgement {
  const inputTickets = input.kind === "qr" ? [input.ticket] : input.tickets;
  const first = inputTickets[0];
  if (first === undefined) throw new Error("判定するチケットがない");
  const user = buildUserView(first.userName, index, states);

  // 受け付けるイベントか（FR-9, 10）。QR の読み取りだけ
  if (input.kind === "qr" && !reception.accept.includes(input.ticket.eventId)) {
    const suggestion = suggestSwitch(context.config, reception, context.now, input.ticket.eventId);
    if (suggestion === null) return { kind: "outOfScope", user };
    return { kind: "suggestSwitch", user, reception: suggestion.reception, outOfPeriod: suggestion.outOfPeriod };
  }

  // 所持が必須のイベント（FR-12, 14）
  const owned = new Set(user.tickets.map((ticket) => ticket.eventId));
  if (!reception.require.every((eventId) => owned.has(eventId))) {
    return { kind: "rejected", user, message: reception.rejectMessage };
  }

  // チェックインするイベントのチケットを 1 枚も持たない（FR-16）
  if (!reception.checkin.some((eventId) => owned.has(eventId))) {
    return { kind: "noTicketToCheckIn", user, checkInEvents: [...reception.checkin] };
  }

  // チェックインするイベントごとに、済みにするチケットを決める（FR-13, 15）
  const inputTokens = new Set(inputTickets.map((ticket) => ticket.ticketToken));
  const toDo = new Set<string>();
  const remainingEvents: string[] = [];
  const bases: CheckinRecord[] = [];
  for (const eventId of reception.checkin) {
    const tickets = user.tickets.filter((ticket) => ticket.eventId === eventId);
    if (tickets.length === 0) continue;
    for (const ticket of tickets) {
      if (ticket.state.done) bases.push(ticket.state.basis);
    }
    const chosen = tickets.filter((ticket) => inputTokens.has(ticket.ticketToken));
    if (chosen.length > 0) {
      // 読み取った（検索で選んだ）チケットだけを済みにする。同じイベントのほかのチケットは変えない
      for (const ticket of chosen) toDo.add(ticket.ticketToken);
    } else if (tickets.some((ticket) => ticket.state.done)) {
      // いずれか 1 枚が済みなら、そのイベントは済みとして扱う
    } else if (tickets.length === 1) {
      toDo.add((tickets[0] as Ticket).ticketToken);
    } else {
      remainingEvents.push(eventId);
    }
  }

  // 既に済みのチケットは変えない（FR-13）
  const newlyDone: Ticket[] = user.tickets
    .filter((ticket) => toDo.has(ticket.ticketToken) && !ticket.state.done)
    .map(({ state: _state, ...ticket }) => ticket);

  if (remainingEvents.length > 0) return { kind: "continue", user, newlyDone, remainingEvents };
  if (newlyDone.length > 0) return { kind: "success", user, newlyDone };

  // 済みの根拠は、最も新しいもの。ここに来るのは、チケットを持つ checkin のイベントのすべてに済みのチケットがあるときだけである
  const basis = bases.reduce<CheckinRecord | undefined>(
    (latest, record) => (latest === undefined || compareRecords(record, latest) > 0 ? record : latest),
    undefined,
  );
  if (basis === undefined) throw new Error("済みの根拠の記録がない");
  return { kind: "alreadyDone", user, basis };
}
