import { openCancelConfirm, setHistoryFilter } from "../../commands/index.ts";
import { formatClock, historyOperations, operationView, type OperationView } from "../../state/index.ts";
import { Button } from "../Button.tsx";
import { Header } from "../Header.tsx";
import { CheckinIcon, CloudUploadIcon, UndoIcon } from "../icons.tsx";
import { RecordRow } from "../RecordRow.tsx";
import { ScreenFrame } from "../ScreenFrame.tsx";
import { SearchField } from "./Search.tsx";
import { TicketList, TicketStatus } from "../TicketList.tsx";

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
      {operations.length === 0 ? (
        <p class="p-4 text-ink-sub">記録なし</p>
      ) : (
        <ul>
          {operations.map((operation) => (
            <li key={operation.opId}>
              <RecordRow operation={operation} detail />
            </li>
          ))}
        </ul>
      )}
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
