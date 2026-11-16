import { useEffect, useRef, useState } from "preact/hooks";
import { openCancelConfirm, setHistoryFilter } from "../../commands/index.ts";
import { formatClock, historyOperations, type Operation, operationView, type OperationView } from "../../state/index.ts";
import { Button } from "../Button.tsx";
import { Header } from "../Header.tsx";
import { CheckinIcon, CloudUploadIcon, UndoIcon } from "../icons.tsx";
import { RecordRow } from "../RecordRow.tsx";
import { ScreenFrame } from "../ScreenFrame.tsx";
import { SearchField } from "./Search.tsx";
import { TicketList, TicketStatus } from "../TicketList.tsx";

/** 最初に描く行の数と、続きを足すときの 1 回の行の数 */
const HISTORY_CHUNK = 100;

/**
 * 記録の一覧。先頭から HISTORY_CHUNK 行だけを描き、終わりの近くまでスクロールしたら、続きを足す。
 * 並びと中身は、全行を描いたときと同じである。記録は数千件になり（PRD NFR-1 の条件）、全行を一度に描くと、
 * 開くときと絞り込みを消すときに、見えていない行の分まで待たされる。絞り込みが変わったら、先頭からやり直す。
 * 一覧ごと作り直すのではなく、行の数だけを戻す。絞り込みの前後で残る行は、作り直さずに使い回す
 */
function OperationList({ operations, filter }: { operations: Operation[]; filter: string }) {
  const [grown, setGrown] = useState({ filter, limit: HISTORY_CHUNK });
  // 絞り込みが変わったら、足した分を捨てる。捨てずに残すと、同じ絞り込みに戻したとき（絞り込みを消したとき）に、
  // 前に足した行を一度に描く
  if (grown.filter !== filter) setGrown({ filter, limit: HISTORY_CHUNK });
  const limit = grown.filter === filter ? grown.limit : HISTORY_CHUNK;
  const more = operations.length > limit;
  const shown = more ? operations.slice(0, limit) : operations;
  /**
   * 描いてある行の終わりに重ねた、高さ 1000px（20 行ほど）の見えない帯。これが見えたら、続きを足す。
   * 1 行ではなく帯にするのは、終わりまで一度に飛んだとき（勢いのあるスクロール、End キー）にも見えるようにするため。
   * キーボードと読み上げで行を順にたどったときも、最後の行に着く前に帯に入る
   */
  const tail = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = tail.current;
    if (!more || element === null) return;
    // 足した後も帯が見えていれば（終わりまで飛んだ直後）、作り直した監視が、もう一度足す
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setGrown((current) => ({ filter, limit: (current.filter === filter ? current.limit : HISTORY_CHUNK) + HISTORY_CHUNK }));
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [more, limit, filter]);

  return (
    <div class="relative">
      <ul>
        {shown.map((operation) => (
          <li key={operation.opId}>
            <RecordRow operation={operation} detail />
          </li>
        ))}
      </ul>
      {more && <div ref={tail} aria-hidden="true" class="pointer-events-none absolute inset-x-0 bottom-0 h-250" />}
    </div>
  );
}

/** S07 履歴。同期済みのすべての端末の分と、この端末の未同期の分を合わせて、新しい順に並べる */
export function History({ filter }: { filter: string }) {
  const operations = historyOperations(filter);
  return (
    <ScreenFrame
      header={
        <>
          <Header back="戻る" />
          <SearchField value={filter} label="履歴を検索" onInput={setHistoryFilter} />
        </>
      }
    >
      {operations.length === 0 ? <p class="p-4 text-ink-sub">記録なし</p> : <OperationList operations={operations} filter={filter} />}
    </ScreenFrame>
  );
}

const ROUTE_TEXT = { qr: "QR", search: "検索" } as const;
const REASON_TEXT = { mistake: "誤操作", wrong_person: "別人だった" } as const;

/** 理由の値。区分が「その他」のときは、区分の代わりに自由記述を出す */
function reasonText(reason: NonNullable<OperationView["reason"]>): string {
  return reason.kind === "other" ? (reason.text ?? "") : REASON_TEXT[reason.kind];
}

function noteText(note: OperationView["notes"][number]): string {
  switch (note.kind) {
    case "allCancelled":
      return "取り消し済み";
    case "cancelled":
      return `${note.ticketNo} 取り消し済み`;
    case "otherFirst":
      return `${note.ticketNo} 他の端末の記録が先`;
  }
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div class="flex gap-4 border-b border-divider py-3 last:border-b-0">
      <dt class="w-20 shrink-0 font-bold text-ink-sub">{label}</dt>
      {/* 自由記述も、記法として解釈せずに、文字列のまま出す */}
      <dd class="min-w-0 flex-1 font-bold wrap-anywhere whitespace-pre-wrap">{value}</dd>
    </div>
  );
}

/** S08 記録の詳細。1 回の操作の記録の詳細を出し、チェックインを取り消す入口になる */
export function OperationDetail({ opId }: { opId: string }) {
  const view = operationView(opId);
  return (
    <ScreenFrame header={<Header back="戻る" />}>
      {view !== null && (
        <>
          <div class="flex flex-col gap-2 p-4">
            <h1 class="flex items-center gap-2 text-2 font-bold">
              {view.op === "checkin" ? <CheckinIcon class="size-7 text-ink-sub" /> : <UndoIcon class="size-7 text-ink-sub" />}
              {view.op === "checkin" ? "チェックイン" : "取り消し"}
            </h1>
            <p class="font-bold text-ink-sub tabular-nums">{formatClock(view.deviceTime)}</p>
            <div>
              <p class="text-1 leading-9 font-bold wrap-anywhere">{view.userName}</p>
              {view.name !== "" && <p class="font-bold text-ink-sub wrap-anywhere">{view.name}</p>}
            </div>
          </div>

          <div class="border-y border-divider bg-surface px-4 pt-1 pb-4">
            {/* S08 には、アンケートの回答を出さない。状態は、現在の状態 */}
            <TicketList groups={view.groups} answers={false}>
              {view.missing.length > 0 && (
                <div class="ticket-group gap-y-1">
                  <h2 class="pt-2 text-5 font-bold text-ink-sub">データにないチケット</h2>
                  {view.missing.map((ticket) => (
                    <div key={ticket.ticketToken} class="ticket-row px-3 py-2">
                      <TicketStatus status={ticket.done ? "done" : "todo"} doneAt={ticket.doneAt} />
                      <span class="wrap-anywhere">{ticket.ticketNo}</span>
                    </div>
                  ))}
                </div>
              )}
            </TicketList>
          </div>

          {/* 詳細。未同期の印も、詳細の要素として同じ枠の中に出す（画面設計書 S08） */}
          <div class="mt-2 border-y border-divider bg-surface px-4">
            <dl>
              <DetailRow label="受付" value={view.receptionName ?? "受付なし"} />
              {view.reason !== null ? (
                <DetailRow label="理由" value={reasonText(view.reason)} />
              ) : (
                <DetailRow label="経路" value={view.route === null ? "" : ROUTE_TEXT[view.route]} />
              )}
              <DetailRow label="操作者" value={view.operatorName} />
              <DetailRow label="端末" value={view.deviceName} />
            </dl>
            {view.unsent && (
              <p class="flex items-center gap-2 border-t border-divider py-3 font-bold text-ink-sub">
                <CloudUploadIcon class="size-5 shrink-0" />
                未同期
              </p>
            )}
          </div>

          {view.notes.length > 0 && (
            <ul class="flex flex-col gap-1 px-4 pt-4">
              {view.notes.map((note) => (
                <li key={noteText(note)} class="font-bold wrap-anywhere">
                  {noteText(note)}
                </li>
              ))}
            </ul>
          )}

          {/* 「取り消す」は、下部固定ではなく本文の末尾に置く。直前の S02 の主ボタンと同じ位置を避ける（画面設計書 2.5） */}
          {view.cancellable.length > 0 && (
            <div class="p-4">
              <Button kind="caution" onClick={openCancelConfirm}>
                取り消す
              </Button>
            </div>
          )}
        </>
      )}
    </ScreenFrame>
  );
}
