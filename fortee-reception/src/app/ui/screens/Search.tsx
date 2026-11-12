import { useEffect, useRef } from "preact/hooks";
import {
  openCandidate,
  openSearchCheckinConfirm,
  selectTicket,
  setSearchQuery,
} from "../../commands/index.ts";
import { candidateView, type Screen, searchCandidates, searchColumnLabels } from "../../state/index.ts";
import { Button } from "../Button.tsx";
import { Header } from "../Header.tsx";
import { SearchIcon } from "../icons.tsx";
import { ScreenFrame } from "../ScreenFrame.tsx";
import { TicketList, TicketSelect } from "../TicketList.tsx";

type FieldProps = {
  value: string;
  /** 読み上げの名前 */
  label: string;
  placeholder?: string;
  /** 画面を開いたらすぐに入力できる状態にする */
  focus?: boolean;
  onInput: (value: string) => void;
};

/** 検索の入力欄（S05、S07）。上部固定に置く。文字は 16px（iOS は、これより小さい入力欄にフォーカスすると拡大する） */
export function SearchField({ value, label, placeholder, focus, onInput }: FieldProps) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (focus === true) ref.current?.focus();
  }, [focus]);
  return (
    <div class="px-4 pt-1 pb-3">
      <label class="field flex min-h-12 items-center gap-2 rounded-pressable border border-outline bg-surface px-3">
        <SearchIcon class="size-5 shrink-0 text-ink-sub" />
        <input
          ref={ref}
          type="text"
          inputMode="search"
          enterkeyhint="search"
          autocomplete="off"
          autocapitalize="off"
          autocorrect="off"
          spellcheck={false}
          class="min-h-11 min-w-0 flex-1 bg-transparent text-4 placeholder:text-ink-sub"
          aria-label={label}
          placeholder={placeholder}
          value={value}
          onInput={(event) => onInput(event.currentTarget.value)}
        />
      </label>
    </div>
  );
}

/** S05 検索。QR を持たない来場者を、端末内のデータから探す */
export function Search({ query }: { query: string }) {
  const candidates = searchCandidates(query);
  return (
    <ScreenFrame
      header={
        <>
          <Header back="戻る" />
          <SearchField
            value={query}
            label="検索"
            placeholder={searchColumnLabels().join("・")}
            focus
            onInput={setSearchQuery}
          />
        </>
      }
    >
      {/* 入力の前は、本文に何も出さない */}
      {candidates.length > 0 && (
        <ul>
          {candidates.map((candidate) => (
            <li key={candidate.userName}>
              <button
                type="button"
                class="flex w-full flex-col gap-1 border-b border-divider bg-surface px-4 py-3 text-left"
                onClick={() => openCandidate(candidate.userName)}
              >
                <span class="truncate font-bold">{candidate.userName}</span>
                {candidate.name !== "" && <span class="truncate text-5 text-ink-sub">{candidate.name}</span>}
                <span class="flex flex-wrap gap-x-4">
                  {candidate.tickets.map((ticket) => (
                    <span key={ticket.ticketToken} class="whitespace-nowrap">
                      {ticket.ticketNo} {ticket.done ? "済" : "未"}
                    </span>
                  ))}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {candidates.length === 0 && query.trim() !== "" && <p class="p-4 text-ink-sub">該当なし</p>}
    </ScreenFrame>
  );
}

/** S06 候補の詳細。本人確認と、チェックインするチケットの指定を行う */
export function Candidate({ state }: { state: Extract<Screen, { id: "S06" }> }) {
  const view = candidateView();
  if (view === null) return null;
  const selectable = view.blocked === null;
  return (
    <ScreenFrame
      header={<Header back="戻る" />}
      // 選べるチケットがないときと、受付なしのときは、置かない
      footer={
        selectable ? (
          <Button kind="caution" disabled={!view.complete} onClick={openSearchCheckinConfirm}>
            検索からチェックイン
          </Button>
        ) : undefined
      }
    >
      <div class="p-4">
        <h1 class="text-1 leading-9 font-bold wrap-anywhere">{view.userName}</h1>
        {view.name !== "" && <p class="font-bold text-ink-sub wrap-anywhere">{view.name}</p>}
      </div>
      {selectable && (
        <div class="px-4 pb-4">
          <TicketSelect groups={view.selectable} selected={state.selected} onSelect={selectTicket} />
        </div>
      )}
      {/* 選択の対象にならないチケット。選べない。回答は閉じておき、行を押すと開く */}
      {view.others.length > 0 && (
        <div class="border-y border-divider bg-surface px-4 pt-1 pb-4">
          <TicketList groups={view.others} />
        </div>
      )}
      {/* チェックインできない理由。画面設計書 S06 の要素の順で、ほかのチケットの下に出す */}
      {view.blocked !== null && (
        <p class="p-4 font-bold">
          {view.blocked.kind === "noReception"
            ? "受付なし"
            : `${view.blocked.eventNames.join("、")}のチケットがありません`}
        </p>
      )}
    </ScreenFrame>
  );
}
