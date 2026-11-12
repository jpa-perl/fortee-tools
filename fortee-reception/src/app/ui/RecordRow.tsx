import { openOperation } from "../commands/index.ts";
import { formatClock, type Operation } from "../state/index.ts";
import { CheckinIcon, CloudUploadIcon, UndoIcon } from "./icons.tsx";

type Props = {
  operation: Operation;
  /** 操作者と、未同期のアイコンを出すか（S07）。S02 と S03 の直近の記録では出さない */
  detail?: boolean;
  /** 収まらない行（S02、S03）。場所は取るが、見せず、押せない */
  hidden?: boolean;
  class?: string;
};

/**
 * 記録の 1 行（S02 と S03 の直近の記録、S07）。1 回の操作を 1 行にまとめる。
 * ユーザ名は 1 行に収めて末尾を省略する。ユーザ名に 5 文字分の幅を残せないときは、チケット番号
 * （S07 では操作者と未同期のアイコンも）が 2 行目の右端に回る（画面設計書 2.9）。チケット番号は省略しない
 */
export function RecordRow({ operation, detail, hidden, class: className }: Props) {
  return (
    <button
      type="button"
      class={
        "flex min-h-13 w-full flex-wrap items-center gap-x-2 border-b border-divider bg-surface px-4 py-2 text-left " +
        `${hidden === true ? "invisible" : ""} ${className ?? ""}`
      }
      onClick={() => openOperation(operation.opId)}
    >
      <span class="text-5 text-ink-sub tabular-nums">{formatClock(operation.deviceTime)}</span>
      {operation.op === "checkin" ? (
        <CheckinIcon class="size-5 shrink-0 text-ink-sub" label="チェックイン" />
      ) : (
        <>
          <UndoIcon class="size-5 shrink-0 text-ink-sub" />
          <span class="shrink-0 font-bold">取り消し</span>
        </>
      )}
      <span class="min-w-22 flex-1 truncate font-bold">{operation.userName}</span>
      <span class="ml-auto flex max-w-full items-center gap-2">
        <span class="text-right">{operation.ticketNos.join("、")}</span>
        {detail === true && <span class="max-w-24 truncate text-5 text-ink-sub">{operation.operatorName}</span>}
        {detail === true && operation.unsent && (
          <CloudUploadIcon class="size-5 shrink-0 text-ink-sub" label="未同期" />
        )}
      </span>
    </button>
  );
}
