import type { PublishedConfig, Reception } from "../../core/config.ts";
import { deviceName } from "../../core/device.ts";
import { buildUserView, type Judgement } from "../../core/judge.ts";
import { type CheckinRecord, clampReasonText, REASON_TEXT_MAX_LENGTH } from "../../core/record.ts";
import { isBasis, isCancelled, stateOf, type TicketState } from "../../core/records.ts";
import { receptionDisplayName, type ReceptionStatus, receptionStatus } from "../../core/reception.ts";
import { normalizeSearchText, search, type SearchMatch } from "../../core/search.ts";
import { combineNames, type Ticket, ticketComparator } from "../../core/snapshot.ts";
import { buildTemplateContext, renderTemplate } from "../../core/template.ts";
import { formatTime } from "../../core/time.ts";
import {
  autoReception,
  type Operation,
  operations,
  searchIndex,
  snapshotIndex,
  ticketStates,
} from "./derived.ts";
import {
  config,
  confirmedReception,
  deviceId,
  now,
  type ReceptionChange,
  screen,
  snapshots,
} from "./model.ts";

// 画面ごとの表示用の値。画面（ui）は core を直接呼ばない（Design Doc 6.1）ので、
// 規則に基づく値は、ここの関数で作って渡す。どの関数も Signal を読むので、描画の中で呼べば、
// 値が変わったときに描き直される。文言は画面が組み立てる。

// ───────── 共通 ─────────

/** 取り消しの理由の自由記述の上限（S08-M1）。JavaScript の文字列の長さで数える。超えては入力できないようにする */
export const REASON_TEXT_MAX = REASON_TEXT_MAX_LENGTH;

/** 入力された自由記述を、記録に持てる形にする（上限で切り、保存できない文字を除く。S08-M1） */
export const reasonTextOf = clampReasonText;

/** 画面に出す時刻（画面設計書 2.9）。設定のタイムゾーンで、当日は「08:30」、それ以外は「11/28 08:30」 */
export function formatClock(epochMs: number): string {
  const current = config.value;
  return current === null ? "" : formatTime(epochMs, now.value, current.conference.timezone);
}

/** 端末名（「端末 7F3K」）。記録の端末 ID からも、同じ規則で出す */
export function deviceLabel(id: string | null = deviceId.value): string {
  return id === null ? "" : deviceName(id);
}

/** イベントの表示名。設定にないイベントは ID をそのまま返す */
export function eventName(eventId: string): string {
  return config.value?.events.find((event) => event.id === eventId)?.name ?? eventId;
}

/** 記録が持つ受付の識別子から、いまの設定の表示名を引く。設定から消えた受付は識別子を、受付なしは null を返す */
export function receptionName(receptionId: string | null): string | null {
  const current = config.value;
  return current === null ? receptionId : receptionDisplayName(current, receptionId);
}

/** データの版（S04 の見つからない、S09）。設定のイベントの順。version は取り込み日時で、端末になければ null */
export function dataVersions(): { eventId: string; eventName: string; version: number | null }[] {
  const versions = new Map(snapshots.value.map((snapshot) => [snapshot.eventId, snapshot.version]));
  return (config.value?.events ?? []).map((event) => ({
    eventId: event.id,
    eventName: event.name,
    version: versions.get(event.id) ?? null,
  }));
}

// ───────── チケットの一覧（画面設計書 2.9。S04、S06、S08 で共通） ─────────

export type TicketRow = {
  ticketToken: string;
  ticketNo: string;
  ticketType: string;
  /** new は今回済み（S04 だけ）、done は済み、todo は未 */
  status: "new" | "done" | "todo";
  /** 済みの時刻（根拠の記録の端末時刻）。今回済みと未は null */
  doneAt: number | null;
  /** fortee 側でだけ済み。行の右端に「fortee 済」を添える */
  forteeOnly: boolean;
  /** S04 で、読み取った（検索で選んだ）チケット。太字にする */
  isInput: boolean;
  /** 設定で選んだアンケートの項目のうち、回答が空でないもの */
  answers: { label: string; value: string }[];
};

export type TicketGroup = {
  eventId: string;
  eventName: string;
  /** S04 の続けて読み取りで、済みにできなかったイベント */
  remaining: boolean;
  tickets: TicketRow[];
};

function answersOf(current: PublishedConfig, ticket: Ticket): TicketRow["answers"] {
  const result: TicketRow["answers"] = [];
  for (const answer of current.display.answers) {
    if (answer.event !== ticket.eventId) continue;
    const value = ticket.answers[answer.field] ?? "";
    if (value !== "") result.push({ label: answer.field, value });
  }
  return result;
}

function ticketRow(
  current: PublishedConfig,
  ticket: Ticket,
  state: TicketState,
  flags: { isNew: boolean; isInput: boolean },
): TicketRow {
  const done = state.done;
  return {
    ticketToken: ticket.ticketToken,
    ticketNo: ticket.ticketNo,
    ticketType: ticket.ticketType,
    status: flags.isNew ? "new" : done ? "done" : "todo",
    doneAt: !flags.isNew && state.done ? state.basis.deviceTime : null,
    forteeOnly: ticket.forteeCheckedIn && !done && !flags.isNew,
    isInput: flags.isInput,
    answers: answersOf(current, ticket),
  };
}

function groupByEvent(rows: { eventId: string; row: TicketRow }[], remaining: readonly string[] = []): TicketGroup[] {
  const groups: TicketGroup[] = [];
  for (const { eventId, row } of rows) {
    let group = groups.find((candidate) => candidate.eventId === eventId);
    if (group === undefined) {
      group = { eventId, eventName: eventName(eventId), remaining: remaining.includes(eventId), tickets: [] };
      groups.push(group);
    }
    group.tickets.push(row);
  }
  return groups;
}

// ───────── S02、S02-M1 ─────────

/** S02 の受付のカード。受付なしなら reception は null。period は、いま含まれる期間で、期間外なら null */
export function receptionCard(): {
  reception: Reception | null;
  manual: boolean;
  period: { start: number; end: number } | null;
} {
  const { reception, manual } = confirmedReception.value;
  const time = now.value;
  const period = reception?.periods.find((candidate) => candidate.start <= time && time < candidate.end) ?? null;
  return { reception, manual, period };
}

/** S02-M1 の受付の一覧。設定の順。current は、いまの受付の行（「現在」と書き、選べない） */
export function receptionChoices(): { id: string; name: string; status: ReceptionStatus; current: boolean }[] {
  const currentId = confirmedReception.value.reception?.id ?? null;
  const time = now.value;
  return (config.value?.receptions ?? []).map((reception) => ({
    id: reception.id,
    name: reception.name,
    status: receptionStatus(reception, time),
    current: reception.id === currentId,
  }));
}

/**
 * S02-M1 の確認の文に使う値。切り替えるときは、その受付の名前と、期間外か。
 * 自動に戻すときは、現在時刻で選んだ受付の名前（受付なしになるなら null）。受付のカードの表示ではない
 */
export function receptionChangePreview(change: ReceptionChange): { name: string | null; outOfPeriod: boolean } {
  if (change.kind === "reset") return { name: autoReception.value?.name ?? null, outOfPeriod: false };
  const reception = config.value?.receptions.find((candidate) => candidate.id === change.receptionId);
  if (reception === undefined) return { name: null, outOfPeriod: false };
  return { name: reception.name, outOfPeriod: receptionStatus(reception, now.value) !== "inPeriod" };
}

// ───────── S04 ─────────

export type ResultTone = "success" | "caution" | "reject";

/** 判定結果を、成功・注意・拒否のどれで知らせるか（画面設計書 2.4）。帯の色と、音と振動の種類 */
export function toneOf(kind: Judgement["kind"] | "notFound"): ResultTone {
  switch (kind) {
    case "success":
      return "success";
    case "continue":
    case "alreadyDone":
    case "suggestSwitch":
      return "caution";
    default:
      return "reject";
  }
}

export type ResultView = {
  /** 判定結果の種類。帯のアイコン、結果名、主ボタンの文言は、画面設計書 2.4 の表で引く */
  kind: Judgement["kind"];
  tone: ResultTone;
  userName: string;
  /** まとめた Name。どれも空なら空文字 */
  name: string;
  /** 判定した受付の表示名 */
  receptionName: string;
  /** 続けて読み取り: 済みにできなかったイベントの表示名 */
  remainingEventNames: string[];
  /** 済み: 根拠の記録（帯の 1 行と「済みの詳細」） */
  basis: { time: number; receptionName: string | null; operatorName: string; deviceName: string } | null;
  /** 切替提案: 提案する受付 */
  suggestion: { receptionName: string; outOfPeriod: boolean } | null;
  /** 拒否: 受付の拒否メッセージ */
  rejectMessage: string | null;
  /** チケットなし: チェックインするイベントの表示名 */
  missingEventNames: string[];
  /** そのユーザの有効なチケットすべて。判定した時点の状態（後から届いた記録では変わらない） */
  groups: TicketGroup[];
};

/** S04 の結果の表示用の値。結果を出していなければ（見つからないを含む）null */
export function resultView(): ResultView | null {
  const current = screen.value;
  const settings = config.value;
  if (current.id !== "home" || current.mode.kind !== "result" || settings === null) return null;
  const { judgement, input, reception } = current.mode;
  const newTokens = new Set(
    judgement.kind === "success" || judgement.kind === "continue"
      ? judgement.newlyDone.map((ticket) => ticket.ticketToken)
      : [],
  );
  const inputTokens = new Set((input.kind === "qr" ? [input.ticket] : input.tickets).map((t) => t.ticketToken));
  const remaining = judgement.kind === "continue" ? judgement.remainingEvents : [];
  return {
    kind: judgement.kind,
    tone: toneOf(judgement.kind),
    userName: judgement.user.userName,
    name: judgement.user.name,
    receptionName: reception.name,
    remainingEventNames: remaining.map(eventName),
    basis:
      judgement.kind === "alreadyDone"
        ? {
            time: judgement.basis.deviceTime,
            receptionName: receptionName(judgement.basis.reception),
            operatorName: judgement.basis.operatorName,
            deviceName: deviceName(judgement.basis.deviceId),
          }
        : null,
    suggestion:
      judgement.kind === "suggestSwitch"
        ? { receptionName: judgement.reception.name, outOfPeriod: judgement.outOfPeriod }
        : null,
    rejectMessage: judgement.kind === "rejected" ? judgement.message : null,
    missingEventNames: judgement.kind === "noTicketToCheckIn" ? judgement.checkInEvents.map(eventName) : [],
    groups: groupByEvent(
      judgement.user.tickets.map(({ state, ...ticket }) => ({
        eventId: ticket.eventId,
        row: ticketRow(settings, ticket, state, {
          isNew: newTokens.has(ticket.ticketToken),
          isInput: inputTokens.has(ticket.ticketToken),
        }),
      })),
      remaining,
    ),
  };
}

/**
 * S04-M1 の参考情報。設定のテンプレートを、判定した時点の状態に今回済みにしたチケットを重ねて描画する
 * （Design Doc 4.6）。描画できなければ null（「表示できません」）
 */
export function referenceText(): string | null {
  const current = screen.value;
  const settings = config.value;
  if (current.id !== "home" || current.mode.kind !== "result" || settings === null) return null;
  const { judgement, records: created, reception } = current.mode;
  const createdAt = new Map(created.map((record) => [record.ticketToken, record.deviceTime]));
  const context = buildTemplateContext({
    userName: judgement.user.userName,
    tickets: judgement.user.tickets.map(({ state, ...ticket }) => {
      const newAt = createdAt.get(ticket.ticketToken);
      if (newAt !== undefined) return { ticket, done: { at: newAt, receptionName: reception.name } };
      if (!state.done) return { ticket, done: null };
      return {
        ticket,
        done: {
          at: state.basis.deviceTime,
          receptionName: receptionDisplayName(settings, state.basis.reception) ?? "",
        },
      };
    }),
    reception,
    config: settings,
    now: now.value,
  });
  const rendered = renderTemplate(settings.template.reference, context);
  return rendered.ok ? rendered.text : null;
}

// ───────── S05 ─────────

/** S05 の入力欄のプレースホルダに並べる、検索対象の列の表示名（「・」で並べるのは画面） */
export function searchColumnLabels(): string[] {
  const settings = config.value;
  if (settings === null) return [];
  const names = { ticketNo: "チケット番号", userName: "ユーザ名", name: "Name" } as const;
  return [...settings.search.columns.map((column) => names[column]), ...settings.search.answers.map((a) => a.field)];
}

export type SearchCandidate = {
  userName: string;
  name: string;
  match: SearchMatch;
  /** 所持チケットと、いまの状態 */
  tickets: { ticketToken: string; ticketNo: string; done: boolean }[];
};

/** S05 の候補の一覧。ユーザ単位で最大 20 件、一致の強さの順。入力が空なら空 */
export function searchCandidates(query: string): SearchCandidate[] {
  const index = snapshotIndex.value;
  const search_ = searchIndex.value;
  if (index === null || search_ === null) return [];
  const states = ticketStates.value;
  return search(search_, query).map((hit) => {
    const tickets = index.byUser.get(hit.userName) ?? [];
    return {
      userName: hit.userName,
      name: combineNames(tickets),
      match: hit.match,
      tickets: tickets.map((ticket) => ({
        ticketToken: ticket.ticketToken,
        ticketNo: ticket.ticketNo,
        done: stateOf(states, ticket.ticketToken).done,
      })),
    };
  });
}

// ───────── S06 ─────────

export type CandidateView = {
  userName: string;
  name: string;
  /** 現在の受付の「チェックインするイベント」のうち、このユーザがチケットを持つイベント。1 枚ずつ選ぶ */
  selectable: TicketGroup[];
  /** 選択の対象にならないチケット */
  others: TicketGroup[];
  /** チェックインできない理由。できるなら null */
  blocked: null | { kind: "noReception" } | { kind: "noTicket"; eventNames: string[] };
  /** すべてのイベントで 1 枚ずつ選んであるか。「検索からチェックイン」を押せるか */
  complete: boolean;
  /** 選んだチケットの番号（S06-M1 の文） */
  selectedTicketNos: string[];
  /** 現在の受付の表示名。受付なしなら null */
  receptionName: string | null;
};

/** S06 の最初の選択（FR-26）。済みのチケットがあればそれを、なければ 1 枚だけのイベントはその 1 枚を選ぶ */
export function defaultSelection(userName: string): Record<string, string> {
  const index = snapshotIndex.value;
  const reception = confirmedReception.value.reception;
  if (index === null || reception === null) return {};
  const user = buildUserView(userName, index, ticketStates.value);
  const selected: Record<string, string> = {};
  for (const eventId of reception.checkin) {
    const tickets = user.tickets.filter((ticket) => ticket.eventId === eventId);
    const chosen = tickets.find((ticket) => ticket.state.done) ?? (tickets.length === 1 ? tickets[0] : undefined);
    if (chosen !== undefined) selected[eventId] = chosen.ticketToken;
  }
  return selected;
}

/** S06 の表示用の値。届いた記録で、すぐに描き直される。S06 でなければ null */
export function candidateView(): CandidateView | null {
  const current = screen.value;
  const settings = config.value;
  const index = snapshotIndex.value;
  if (current.id !== "S06" || settings === null || index === null) return null;
  const reception = confirmedReception.value.reception;
  const user = buildUserView(current.userName, index, ticketStates.value);
  const checkin = reception?.checkin ?? [];
  const rows = user.tickets.map(({ state, ...ticket }) => ({
    eventId: ticket.eventId,
    row: ticketRow(settings, ticket, state, { isNew: false, isInput: false }),
  }));
  const selectable = groupByEvent(rows.filter(({ eventId }) => checkin.includes(eventId)));
  const selectedTokens = selectable
    .map((group) => current.selected[group.eventId])
    .filter((token): token is string => token !== undefined);
  return {
    userName: user.userName,
    name: user.name,
    selectable,
    others: groupByEvent(rows.filter(({ eventId }) => !checkin.includes(eventId))),
    blocked:
      reception === null
        ? { kind: "noReception" }
        : selectable.length === 0
          ? { kind: "noTicket", eventNames: checkin.map(eventName) }
          : null,
    complete:
      reception !== null &&
      selectable.length > 0 &&
      selectable.every((group) => group.tickets.some((t) => t.ticketToken === current.selected[group.eventId])),
    selectedTicketNos: selectedTokens.map((token) => index.byToken.get(token)?.ticketNo ?? ""),
    receptionName: reception?.name ?? null,
  };
}

// ───────── S07 ─────────

/** S07 の一覧。ユーザ名とチケット番号（記録が持つ値）の部分一致で絞り込む。空なら全件。新しい順 */
export function historyOperations(filter: string): Operation[] {
  const needle = normalizeSearchText(filter);
  if (needle === "") return operations.value;
  return operations.value.filter(
    (operation) =>
      normalizeSearchText(operation.userName).includes(needle) ||
      operation.ticketNos.some((ticketNo) => normalizeSearchText(ticketNo).includes(needle)),
  );
}

// ───────── S08、S08-M1 ─────────

export type OperationView = {
  opId: string;
  op: "checkin" | "cancel";
  deviceTime: number;
  userName: string;
  /** 対象のチケットのうち、データにあるものの Name をまとめた値。なければ空文字 */
  name: string;
  /** 対象のチケットのうち、データにあるもの。いまの状態 */
  groups: TicketGroup[];
  /** データにないチケット。番号と、いまの状態だけを出す */
  missing: { ticketToken: string; ticketNo: string; done: boolean; doneAt: number | null }[];
  /** 受付の表示名。受付なしのときに行った取り消しでは null */
  receptionName: string | null;
  /** チェックインの経路。取り消しでは null */
  route: "qr" | "search" | null;
  /** 取り消しの理由。チェックインでは null。区分が other のときは text を出す */
  reason: { kind: "mistake" | "wrong_person" | "other"; text: string | null } | null;
  operatorName: string;
  deviceName: string;
  unsent: boolean;
  /**
   * 注記（チェックインの記録だけ）。この記録が済みの根拠になっていないチケットごとに 1 行。
   * 対象のチケットがすべて取り消し済みなら、allCancelled の 1 行にまとめる
   */
  notes: ({ kind: "allCancelled" } | { kind: "cancelled"; ticketNo: string } | { kind: "otherFirst"; ticketNo: string })[];
  /** この記録が済みの根拠になっているチケット。1 枚以上あれば「取り消す」を出す。S08-M1 の対象 */
  cancellable: { ticketToken: string; ticketNo: string; ticketType: string | null }[];
};

/** S08 の表示用の値。届いた記録で、すぐに描き直される。その操作の記録がなければ null */
export function operationView(opId: string): OperationView | null {
  const operation = operations.value.find((candidate) => candidate.opId === opId);
  const settings = config.value;
  if (operation === undefined || settings === null) return null;
  const index = snapshotIndex.value;
  const states = ticketStates.value;
  const first = operation.records[0] as CheckinRecord;

  // チケットごとに 1 件。取り消しを複数の記録に分けたときも、チケットは 1 つ
  const byTicket = new Map<string, CheckinRecord>();
  for (const record of operation.records) {
    if (!byTicket.has(record.ticketToken)) byTicket.set(record.ticketToken, record);
  }
  const present: Ticket[] = [];
  const missing: OperationView["missing"] = [];
  for (const record of byTicket.values()) {
    const ticket = index?.byToken.get(record.ticketToken);
    const state = stateOf(states, record.ticketToken);
    if (ticket !== undefined) present.push(ticket);
    else {
      missing.push({
        ticketToken: record.ticketToken,
        ticketNo: record.ticketNo,
        done: state.done,
        doneAt: state.done ? state.basis.deviceTime : null,
      });
    }
  }
  present.sort(ticketComparator(settings.events.map((event) => event.id)));

  const notes: OperationView["notes"] = [];
  const cancellable: OperationView["cancellable"] = [];
  if (operation.op === "checkin") {
    for (const record of byTicket.values()) {
      if (isBasis(record, states)) {
        cancellable.push({
          ticketToken: record.ticketToken,
          ticketNo: record.ticketNo,
          ticketType: index?.byToken.get(record.ticketToken)?.ticketType ?? null,
        });
      } else if (isCancelled(record, states)) {
        notes.push({ kind: "cancelled", ticketNo: record.ticketNo });
      } else {
        notes.push({ kind: "otherFirst", ticketNo: record.ticketNo });
      }
    }
  }
  const allCancelled = notes.length === byTicket.size && notes.every((note) => note.kind === "cancelled");

  return {
    opId,
    op: operation.op,
    deviceTime: operation.deviceTime,
    userName: operation.userName,
    name: combineNames(present),
    groups: groupByEvent(
      present.map((ticket) => ({
        eventId: ticket.eventId,
        row: ticketRow(settings, ticket, stateOf(states, ticket.ticketToken), { isNew: false, isInput: false }),
      })),
    ),
    missing,
    receptionName: receptionDisplayName(settings, first.reception),
    route: first.route,
    reason: first.op === "cancel" ? { kind: first.reasonKind, text: first.reasonText } : null,
    operatorName: operation.operatorName,
    deviceName: deviceName(operation.deviceId),
    unsent: operation.unsent,
    notes: allCancelled ? [{ kind: "allCancelled" }] : notes,
    cancellable,
  };
}
