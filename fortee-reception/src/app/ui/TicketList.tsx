import type { ComponentChildren } from "preact";
import { useState } from "preact/hooks";
import { formatClock, type TicketGroup, type TicketRow } from "../state/index.ts";
import { CheckIcon, ChevronDownIcon, ChevronUpIcon, DoneMark, ResultQrIcon, TodoMark } from "./icons.tsx";

// チケットの一覧（画面設計書 2.9。S04、S06、S08 で共通）。イベントごとにまとめ、各行の左端に状態のマークと
// 文字を縦にそろえて置く。列をそろえる grid は styles.css の .ticket-list にある。

/** 状態のマークと文字。形・色・文字で見分ける */
export function TicketStatus({ status, doneAt }: { status: TicketRow["status"]; doneAt: number | null }) {
  switch (status) {
    case "new":
      return (
        <>
          <DoneMark class="size-6 text-ok" />
          <span>今回</span>
        </>
      );
    case "done":
      return (
        <>
          <DoneMark class="size-6 text-done" />
          <span class="whitespace-nowrap">済{doneAt !== null && ` ${formatClock(doneAt)}`}</span>
        </>
      );
    case "todo":
      return (
        <>
          <TodoMark class="size-6 text-pending" />
          <span>未</span>
        </>
      );
  }
}

function Answers({ answers }: { answers: TicketRow["answers"] }) {
  return (
    <span class="ticket-answers flex flex-col pt-1">
      {answers.map((answer) => (
        <span key={answer.label} class="wrap-anywhere">
          <span class="pr-2 text-5 text-ink-sub">{answer.label}</span>
          <span class="font-bold whitespace-pre-wrap">{answer.value}</span>
        </span>
      ))}
    </span>
  );
}

/** 行の 1 行目。マーク、状態の文字、チケット番号と種別、右端の添えもの */
function RowHead({ ticket, trailing }: { ticket: TicketRow; trailing?: ComponentChildren }) {
  return (
    <>
      <TicketStatus status={ticket.status} doneAt={ticket.doneAt} />
      <span class="wrap-anywhere">
        {ticket.ticketNo} {ticket.ticketType}
      </span>
      <span class="flex items-center gap-2">
        {ticket.forteeOnly && <span class="text-6 whitespace-nowrap text-ink-sub">fortee 済</span>}
        {trailing}
      </span>
    </>
  );
}

type RowProps = {
  ticket: TicketRow;
  /** アンケートの回答を出すか。S08 では出さない */
  answers: boolean;
  /** 回答を最初から出す行か（S04 の今回済みの行）。ほかの行は閉じておき、行を押すと開く */
  open: boolean;
};

/** 選べない行。回答を閉じている行は、行全体が開閉のボタンになる */
function PlainRow({ ticket, answers, open }: RowProps) {
  const [expanded, setExpanded] = useState(false);
  const tone = ticket.status === "new" ? "rounded-pressable bg-ok-soft" : "";
  const weight = ticket.isInput ? "font-bold" : "";
  const hasAnswers = answers && ticket.answers.length > 0;

  if (!hasAnswers || open) {
    return (
      <div class={`ticket-row px-3 py-2 ${tone} ${weight}`}>
        <RowHead ticket={ticket} />
        {hasAnswers && <Answers answers={ticket.answers} />}
      </div>
    );
  }
  return (
    <button
      type="button"
      class={`ticket-row min-h-12 rounded-pressable px-3 py-2 ${tone} ${weight}`}
      aria-expanded={expanded}
      onClick={() => setExpanded(!expanded)}
    >
      <RowHead
        ticket={ticket}
        trailing={
          expanded ? (
            <ChevronUpIcon class="size-6 text-ink-sub" label="回答" />
          ) : (
            <ChevronDownIcon class="size-6 text-ink-sub" label="回答" />
          )
        }
      />
      {expanded && <Answers answers={ticket.answers} />}
    </button>
  );
}

type ListProps = {
  groups: TicketGroup[];
  /** アンケートの回答を出すか。省くと出す */
  answers?: boolean;
  /** 一覧の末尾に足す行（S08 の「データにないチケット」） */
  children?: ComponentChildren;
};

/** S04 の一覧、S06 の「ほかのチケット」、S08 の対象のチケット */
export function TicketList({ groups, answers, children }: ListProps) {
  return (
    <div class="ticket-list gap-y-1">
      {groups.map((group) => (
        <div class="ticket-group gap-y-1" key={group.eventId}>
          <EventHeading group={group} />
          {group.tickets.map((ticket) => (
            <PlainRow
              key={ticket.ticketToken}
              ticket={ticket}
              answers={answers !== false}
              open={ticket.status === "new"}
            />
          ))}
        </div>
      ))}
      {children}
    </div>
  );
}

export function EventHeading({ group }: { group: Pick<TicketGroup, "eventName" | "remaining"> }) {
  return (
    <h2 class="flex items-center gap-2 pt-2 text-5 font-bold text-ink-sub">
      {group.eventName}
      {group.remaining && <ResultQrIcon class="size-5 text-ink" label="済みにできなかったイベント" />}
    </h2>
  );
}

type SelectProps = {
  groups: TicketGroup[];
  /** イベント ID → 選んだチケットトークン */
  selected: Record<string, string>;
  onSelect: (eventId: string, ticketToken: string) => void;
};

/**
 * S06 のチケットの選択。イベントごとに 1 枚を選ぶ。選んだ行は主色の枠で囲み、右端に、丸で囲まないチェックを出す。
 * ラジオボタンの丸は使わない（読み上げではラジオボタンとして扱う）。回答は、最初から出す
 */
export function TicketSelect({ groups, selected, onSelect }: SelectProps) {
  return (
    <div class="ticket-list gap-y-2">
      {groups.map((group) => (
        <div class="ticket-group gap-y-2" key={group.eventId} role="radiogroup" aria-label={group.eventName}>
          <EventHeading group={group} />
          {group.tickets.map((ticket) => {
            const checked = selected[group.eventId] === ticket.ticketToken;
            return (
              <button
                key={ticket.ticketToken}
                type="button"
                role="radio"
                aria-checked={checked}
                class={
                  "ticket-row min-h-13 rounded-pressable border bg-surface px-3 py-2 " +
                  "border-outline aria-checked:border-selected aria-checked:ring-1 aria-checked:ring-selected aria-checked:ring-inset"
                }
                onClick={() => onSelect(group.eventId, ticket.ticketToken)}
              >
                <RowHead ticket={ticket} trailing={checked && <CheckIcon class="size-6 text-selected" />} />
                {ticket.answers.length > 0 && <Answers answers={ticket.answers} />}
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}
