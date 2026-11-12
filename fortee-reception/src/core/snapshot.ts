import * as z from "zod/mini";
import { epochMsSchema, eventIdSchema, ticketTokenSchema } from "./fields.ts";
import { DISTRIBUTION_FORMAT } from "./versions.ts";

// スナップショット（Design Doc 4.3、PRD 7.1）。イベントごとに 1 つの JSON。
// 参加者の値は CSV の値をそのまま持ち、前後の空白や全角と半角を変えない。

export const attendeeSchema = z.object({
  /** 参加者の識別子 */
  ticketToken: ticketTokenSchema,
  ticketNo: z.string(),
  ticketType: z.string(),
  /** fortee ユーザ名。ユーザの同一性は、この値の完全一致で判定する（FR-12） */
  userName: z.string(),
  /** チケットごとの値（CSV の 1 行ごと） */
  name: z.string(),
  profileUrlToken: z.string(),
  /** fortee 側のチェックイン有無。参考値 */
  forteeCheckedIn: z.boolean(),
  /** そのイベントについて設定で参照する列だけ。鍵は fortee の項目名（CSV の列名） */
  answers: z.record(z.string(), z.string()),
});
export type Attendee = z.infer<typeof attendeeSchema>;

export const snapshotSchema = z.object({
  /** 形式の版（Design Doc 9.5） */
  format: z.literal(DISTRIBUTION_FORMAT),
  eventId: eventIdSchema,
  /** 取り込み日時（FR-44）。同じか違うかだけを見て、大小で新旧を決めない */
  version: epochMsSchema,
  /** answers に取り込んだ列の名前。参加者が 0 人でも設定との整合を確かめられるようにする（Design Doc 9.4） */
  columns: z.array(z.string()),
  attendees: z.array(attendeeSchema),
});
export type Snapshot = z.infer<typeof snapshotSchema>;

// 索引（Design Doc 5.1）。受付アプリと CLI は、全イベントのスナップショットから索引を作って使う。

/** チケット。参加者に、スナップショットのイベント ID を加えたもの */
export type Ticket = Attendee & { eventId: string };

export type SnapshotIndex = {
  /** チケットトークン → チケット */
  byToken: Map<string, Ticket>;
  /** fortee ユーザ名 → そのユーザの有効なチケット。チケットの並び順（compareTickets） */
  byUser: Map<string, Ticket[]>;
  /** イベント ID → 版 */
  versions: Record<string, number>;
};

/** 文字列を符号単位の順で比べる。実行環境のロケールで結果が変わらないように、localeCompare を使わない */
export function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

const DIGITS = /\d+/g;

/** 数字の連なりと、それ以外の連なりに分ける */
function splitDigitRuns(text: string): string[] {
  const runs: string[] = [];
  let last = 0;
  for (const match of text.matchAll(DIGITS)) {
    if (match.index > last) runs.push(text.slice(last, match.index));
    runs.push(match[0]);
    last = match.index + match[0].length;
  }
  if (last < text.length) runs.push(text.slice(last));
  return runs;
}

const isDigitRun = (run: string) => run.charCodeAt(0) >= 0x30 && run.charCodeAt(0) <= 0x39;

/**
 * チケット番号の順。数字（0〜9）の連なりは数として比べ、ほかは符号単位の順で比べる（A-2 は A-12 より前）。
 * 数として同じ（A-02 と A-2）なら、全体を符号単位の順で比べて、順序を一通りに決める
 */
export function compareTicketNo(a: string, b: string): number {
  const runsA = splitDigitRuns(a);
  const runsB = splitDigitRuns(b);
  const length = Math.min(runsA.length, runsB.length);
  for (let i = 0; i < length; i++) {
    const runA = runsA[i] as string;
    const runB = runsB[i] as string;
    if (isDigitRun(runA) && isDigitRun(runB)) {
      // 桁数が多くても比べられるように、先頭の 0 を除いた桁数と、符号単位の順で比べる
      const digitsA = runA.replace(/^0+(?=\d)/, "");
      const digitsB = runB.replace(/^0+(?=\d)/, "");
      if (digitsA.length !== digitsB.length) return digitsA.length - digitsB.length;
      const order = compareCodeUnits(digitsA, digitsB);
      if (order !== 0) return order;
    } else {
      const order = compareCodeUnits(runA, runB);
      if (order !== 0) return order;
    }
  }
  if (runsA.length !== runsB.length) return runsA.length - runsB.length;
  return compareCodeUnits(a, b);
}

/**
 * チケットの並び順を作る（Design Doc 4.3）。設定のイベントの順、同じイベントの中はチケット番号の順。
 * 番号も同じなら、チケットトークンの順で一通りに決める。eventIds にないイベントは最後に置く
 */
export function ticketComparator(eventIds: readonly string[]): (a: Ticket, b: Ticket) => number {
  const position = new Map(eventIds.map((id, i) => [id, i]));
  const positionOf = (eventId: string) => position.get(eventId) ?? eventIds.length;
  return (a, b) =>
    positionOf(a.eventId) - positionOf(b.eventId) ||
    compareCodeUnits(a.eventId, b.eventId) ||
    compareTicketNo(a.ticketNo, b.ticketNo) ||
    compareCodeUnits(a.ticketToken, b.ticketToken);
}

/**
 * 全イベントのスナップショットから索引を作る（Design Doc 5.1）。
 *
 * eventIds は設定のイベントの ID（設定の順）で、チケットの並び順に使う。
 * eventIds にないイベントのスナップショットは索引に入れない。設定にないイベントのチケットは、
 * 本システムから見えない（PRD 9 章 1）。ユーザの同一性は、fortee ユーザ名の完全一致で見る（FR-12）
 */
export function buildSnapshotIndex(snapshots: Iterable<Snapshot>, eventIds: readonly string[]): SnapshotIndex {
  const known = new Set(eventIds);
  const byToken = new Map<string, Ticket>();
  const byUser = new Map<string, Ticket[]>();
  const versions: Record<string, number> = {};
  for (const snapshot of snapshots) {
    if (!known.has(snapshot.eventId)) continue;
    versions[snapshot.eventId] = snapshot.version;
    for (const attendee of snapshot.attendees) {
      const ticket: Ticket = { ...attendee, eventId: snapshot.eventId };
      byToken.set(ticket.ticketToken, ticket);
      const tickets = byUser.get(ticket.userName);
      if (tickets === undefined) byUser.set(ticket.userName, [ticket]);
      else tickets.push(ticket);
    }
  }
  const compare = ticketComparator(eventIds);
  for (const tickets of byUser.values()) tickets.sort(compare);
  return { byToken, byUser, versions };
}

/**
 * ユーザに 1 つの Name を出すところに使う値（PRD 7.1、Design Doc 4.3）。
 * チケットの Name のうち空でないものを、渡された順（チケットの並び順）で、
 * 文字列の完全一致で重複を除いて「、」でつなぐ。どの Name も空なら空文字
 */
export function combineNames(tickets: Iterable<{ name: string }>): string {
  const names = new Set<string>();
  for (const ticket of tickets) {
    if (ticket.name !== "") names.add(ticket.name);
  }
  return [...names].join("、");
}
