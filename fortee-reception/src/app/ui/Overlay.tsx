import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import {
  backToReceptionList,
  type CancelReason,
  cancelQrCheckin,
  chooseAutoReception,
  chooseReception,
  closeOverlay,
  confirmCancel,
  confirmModeChange,
  confirmQrCheckin,
  confirmReceptionChange,
  confirmSearchCheckin,
  confirmSuggestedSwitch,
  logout,
} from "../commands/index.ts";
import {
  busy,
  candidateView,
  confirmedReception,
  hasUnsent,
  lastSyncFailed,
  type ModeChange,
  online,
  operationView,
  type OperationView,
  overlay,
  qrConfirmView,
  REASON_TEXT_MAX,
  reasonTextOf,
  receptionChangePreview,
  receptionChoices,
  referenceHtml,
  rehearsal,
  resultView,
  screen,
} from "../state/index.ts";
import { Button } from "./Button.tsx";
import { prefersReducedMotion } from "./env.ts";
import { CloseIcon, WarningIcon } from "./icons.tsx";

// シートとダイアログ（画面設計書 2.1、Design Doc 6.9）。<dialog> を showModal() で開く。
//
// 中身に出す値は、開いている間に OverlayHost が状態から作って、ただの値として中身に渡す。
// 閉じる動き（0.2 秒）の間は、最後に作った値を出し続ける。状態はもう次に進んでいるので、
// 中身が状態を直接読むと、閉じていく途中で中身が変わってしまう

/** シートが開いてから、確定ボタンを押せるようになるまでの時間（画面設計書 2.5） */
const ARM_MS = 500;
/** 閉じる動きの時間（画面設計書 2.11）。styles.css の --default-transition-duration と同じ値 */
const LEAVE_MS = 200;
/** 下に引いて閉じるのに要る距離 */
const PULL_CLOSE_PX = 72;

type Model =
  | { id: "S02-M1"; step: "list"; manual: boolean; choices: ReturnType<typeof receptionChoices> }
  | { id: "S02-M1"; step: "confirm"; reset: boolean; name: string | null; outOfPeriod: boolean }
  | ({ id: "S03-D1" } & ReturnType<typeof qrConfirmView>)
  | { id: "S04-D1" }
  | { id: "S04-M1"; html: string | null }
  | { id: "S04-M2"; name: string; outOfPeriod: boolean }
  | { id: "S06-M1"; userName: string; ticketNos: string[]; receptionName: string }
  | { id: "S08-M1"; userName: string; receptionName: string | null; cancellable: OperationView["cancellable"] }
  | { id: "S09-D1"; unsent: boolean; status: "offline" | "failed" | null }
  | { id: "S09-D2"; change: ModeChange };

/**
 * 開いているシートかダイアログに出す値。開いていないか、出す値を作れなければ null。
 * 通常受付の確認（S03-D1）は、シートの状態（overlay）ではなく、ホームの状態（confirming）から出す
 */
function currentModel(): Model | null {
  const sheet = overlay.value;
  if (sheet === null) {
    const current = screen.value;
    if (current.id !== "home" || current.mode.kind !== "confirming") return null;
    return { id: "S03-D1", ...qrConfirmView(current.mode.ticket) };
  }
  switch (sheet.id) {
    case "S02-M1": {
      if (sheet.step.kind === "list") {
        return { id: "S02-M1", step: "list", manual: confirmedReception.value.manual, choices: receptionChoices() };
      }
      const preview = receptionChangePreview(sheet.step.change);
      return { id: "S02-M1", step: "confirm", reset: sheet.step.change.kind === "reset", ...preview };
    }
    case "S04-D1":
      return { id: "S04-D1" };
    case "S04-M1":
      return { id: "S04-M1", html: referenceHtml() };
    case "S04-M2": {
      const suggestion = resultView()?.suggestion;
      if (suggestion == null) return null;
      return { id: "S04-M2", name: suggestion.receptionName, outOfPeriod: suggestion.outOfPeriod };
    }
    case "S06-M1": {
      const view = candidateView();
      if (view === null || view.receptionName === null) return null;
      return {
        id: "S06-M1",
        userName: view.userName,
        ticketNos: view.selectedTicketNos,
        receptionName: view.receptionName,
      };
    }
    case "S08-M1": {
      const current = screen.value;
      const view = current.id === "S08" ? operationView(current.opId) : null;
      if (view === null) return null;
      return {
        id: "S08-M1",
        userName: view.userName,
        receptionName: confirmedReception.value.reception?.name ?? null,
        cancellable: view.cancellable,
      };
    }
    case "S09-D1": {
      // 警告は、ヘッダの 1 つの状態（画面設計書 2.3）からではなく、オフラインかと、直前の同期に失敗しているかから選ぶ。
      // ヘッダは「同期中」「再ログインが必要」を同期の失敗より先に出すので、ヘッダの状態で選ぶと、失敗の後の
      // 再試行の間と、再ログインが必要の間に、警告が出ない（FR-37）
      const status = !online.value ? "offline" : lastSyncFailed.value ? "failed" : null;
      // リハーサルモードの間は、端末の記録（本番の記録）を読み込んでいないので、未同期の記録があるかが分からない。
      // あるものとして警告する
      return { id: "S09-D1", unsent: hasUnsent.value || rehearsal.value, status };
    }
    case "S09-D2":
      return { id: "S09-D2", change: sheet.change };
  }
}

/** 開いてから 0.5 秒たったか。key が変わると、数え直す（S02-M1 は、確認に切り替わった時点から数える） */
function useArmed(key: string): boolean {
  const [armedKey, setArmedKey] = useState<string | null>(null);
  useEffect(() => {
    const timer = setTimeout(() => setArmedKey(key), ARM_MS);
    return () => clearTimeout(timer);
  }, [key]);
  return armedKey === key;
}

type ModalProps = {
  kind: "sheet" | "dialog";
  /** 閉じる動きの途中 */
  closing: boolean;
  /** 下に引いて閉じられるか。つまみを出す。確認のシートでは false（画面設計書 2.1） */
  pullable?: boolean;
  /** 参考情報（S04-M1）。画面の下半分程度の高さで開く */
  half?: boolean;
  /** 戻る操作と Esc キーで行うこと。省くと、シートを閉じる。通常受付の確認（S03-D1）は「やめる」にする */
  onDismiss?: () => void;
  children: ComponentChildren;
};

function Modal({ kind, closing, pullable, half, onDismiss = closeOverlay, children }: ModalProps) {
  const ref = useRef<HTMLDialogElement>(null);
  /** この部品が自分で close() を呼んだ。close イベントを、利用者の操作と区別する */
  const closedByHost = useRef(false);
  const pull = useRef<{ startY: number; dy: number } | null>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (dialog === null) return;
    if (!dialog.open) dialog.showModal();
    // 開いたときのフォーカスを、中のボタンではなくダイアログ自身に置く（Design Doc 6.9）。Chromium は、
    // autofocus を付けても中の最初のボタンに置くので、自分で置き直す
    dialog.focus();
    return () => {
      closedByHost.current = true;
      if (dialog.open) dialog.close();
    };
  }, []);

  // 閉じる動きの途中で、同じシートが開き直されたとき（ブラウザが先に閉じていたとき）は、開き直す
  useEffect(() => {
    const dialog = ref.current;
    if (!closing && dialog !== null && !dialog.open) dialog.showModal();
  });

  // Android の戻る操作と Esc キー。「閉じる」「やめる」と同じに扱う（画面設計書 2.1）
  const onCancel = (event: Event) => {
    const sheet = overlay.value;
    const confirmStep = sheet?.id === "S02-M1" && sheet.step.kind === "confirm";
    // S02-M1 の確認では、閉じずに一覧に戻る。確定の処理が進んでいる間は、閉じない。閉じる動きの途中も、何もしない
    if (confirmStep || busy.value || closing) {
      event.preventDefault();
      if (!closing) onDismiss();
    }
  };

  // ブラウザが閉じた（cancel を止められなかった場合を含む）。状態も閉じる
  const onClose = () => {
    if (closedByHost.current || closing) return;
    onDismiss();
    // S02-M1 の確認で閉じられたときは、一覧に戻った後、もう 1 回で閉じる
    if (overlay.value?.id === "S02-M1") closeOverlay();
    // 確定の処理が進んでいて閉じられなかったら、開き直す
    if (currentModel() !== null) ref.current?.showModal();
  };

  const onPointerDown = (event: PointerEvent) => {
    if (closing) return;
    pull.current = { startY: event.clientY, dy: 0 };
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: PointerEvent) => {
    const dialog = ref.current;
    if (pull.current === null || dialog === null) return;
    pull.current.dy = Math.max(0, event.clientY - pull.current.startY);
    dialog.style.transform = `translateY(${pull.current.dy}px)`;
  };
  const onPointerEnd = () => {
    const dialog = ref.current;
    if (pull.current === null || dialog === null) return;
    const { dy } = pull.current;
    pull.current = null;
    dialog.style.transform = "";
    if (dy >= PULL_CLOSE_PX) closeOverlay();
  };

  return (
    <dialog
      ref={ref}
      // ダイアログ自身に、フォーカスを置けるようにする
      autofocus
      tabIndex={-1}
      class={`${kind === "sheet" ? "sheet" : "dialog-box"} ${half === true ? "sheet-half" : ""}`}
      data-closing={closing ? "" : undefined}
      onCancel={onCancel}
      onClose={onClose}
    >
      {pullable === true && (
        <div
          class="flex h-6 touch-none items-center justify-center"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerEnd}
          onPointerCancel={onPointerEnd}
        >
          <span class="sheet-grip" />
        </div>
      )}
      <div class={`flex flex-col gap-4 px-4 pb-4 ${pullable === true ? "" : "pt-6"}`}>{children}</div>
    </dialog>
  );
}

function CloseButton() {
  return (
    <div class="flex justify-end">
      <button
        type="button"
        class="flex size-12 items-center justify-center rounded-pressable"
        aria-label="閉じる"
        onClick={closeOverlay}
      >
        <CloseIcon class="size-7" />
      </button>
    </div>
  );
}

/** 確認のシートの文、確定、やめる（画面設計書 2.5） */
function ConfirmBody(props: {
  lines: (string | null)[];
  confirmLabel: string;
  armed: boolean;
  disabled?: boolean;
  onConfirm: () => void;
  onCancel?: () => void;
  children?: ComponentChildren;
}) {
  return (
    <>
      <div class="flex flex-col gap-1">
        {props.lines.map((line) => line !== null && <p key={line}>{line}</p>)}
      </div>
      {props.children}
      <div class="flex flex-col gap-3 pt-2">
        <Button
          kind="confirm"
          disabled={!props.armed || busy.value || props.disabled === true}
          onClick={props.onConfirm}
        >
          {props.confirmLabel}
        </Button>
        <Button kind="outline" disabled={busy.value} onClick={props.onCancel ?? closeOverlay}>
          やめる
        </Button>
      </div>
    </>
  );
}

// ───────── S02-M1 受付の切り替え ─────────

const STATUS_TEXT = { inPeriod: "期間中", upcoming: "これから", ended: "終了" } as const;

function ReceptionList({ model }: { model: Extract<Model, { id: "S02-M1"; step: "list" }> }) {
  return (
    <>
      <CloseButton />
      {/* 「自動に戻す」は、一覧の上に置く。S02 の主ボタンと同じ位置を避ける（画面設計書 2.5） */}
      {model.manual && (
        <Button kind="caution" onClick={chooseAutoReception}>
          自動に戻す
        </Button>
      )}
      <ul class="flex flex-col gap-3">
        {model.choices.map((choice) => (
          <li key={choice.id}>
            {choice.current ? (
              <div class="flex min-h-14 items-center gap-3 rounded-pressable bg-ground px-4 py-2">
                <span class="min-w-0 flex-1 font-bold wrap-anywhere">{choice.name}</span>
                <span class="shrink-0 text-5 font-bold text-ink-sub">{STATUS_TEXT[choice.status]}</span>
                <span class="shrink-0 text-5 font-bold">現在</span>
              </div>
            ) : (
              <button
                type="button"
                class="flex min-h-14 w-full items-center gap-3 rounded-pressable border-2 border-caution bg-surface px-4 py-2 text-left"
                onClick={() => chooseReception(choice.id)}
              >
                <span class="min-w-0 flex-1 font-bold wrap-anywhere">{choice.name}</span>
                <span class="shrink-0 text-5 font-bold text-ink-sub">{STATUS_TEXT[choice.status]}</span>
                <WarningIcon class="size-5 shrink-0 text-caution" />
              </button>
            )}
          </li>
        ))}
      </ul>
      {/* 最下行が、S02 の主ボタンの上端より上に収まるように、余白を空ける */}
      <div class="h-24" />
    </>
  );
}

function ReceptionConfirm({ model }: { model: Extract<Model, { id: "S02-M1"; step: "confirm" }> }) {
  const armed = useArmed(`S02-M1:${model.reset ? "reset" : (model.name ?? "")}`);
  const lines = model.reset
    ? [`自動の選択に戻します。${model.name === null ? "受付なしになります" : `受付は ${model.name} になります`}`]
    : [
        `この端末の受付を ${model.name ?? ""} に固定します。解除するか、次の期間の境目までこのままです`,
        model.outOfPeriod ? `${model.name ?? ""}は期間外です` : null,
      ];
  return (
    <ConfirmBody
      lines={lines}
      confirmLabel={model.reset ? "戻す" : "切り替える"}
      armed={armed}
      onConfirm={() => void confirmReceptionChange()}
      onCancel={backToReceptionList}
    />
  );
}

// ───────── S04-M1、S04-M2、S06-M1 ─────────

function Reference({ model }: { model: Extract<Model, { id: "S04-M1" }> }) {
  return (
    <>
      <CloseButton />
      {/*
        描画結果を HTML として出す。空白と改行の扱いも HTML のとおりで、改行は表示に出ない（画面設計書 S04-M1）。
        HTML はテンプレートに書いたものだけで、変数の値は描画のときにエスケープしてある（Design Doc 4.6）
      */}
      {model.html === null ? (
        <p class="pb-4">表示できません</p>
      ) : (
        <div class="reference pb-4 wrap-anywhere" dangerouslySetInnerHTML={{ __html: model.html }} />
      )}
    </>
  );
}

function SwitchConfirm({ model }: { model: Extract<Model, { id: "S04-M2" }> }) {
  const armed = useArmed("S04-M2");
  return (
    <ConfirmBody
      lines={[
        `この端末の受付を ${model.name} に固定して、このチケットを判定し直します`,
        model.outOfPeriod ? `${model.name}は期間外です` : null,
      ]}
      confirmLabel="切り替える"
      armed={armed}
      // 音を鳴らせる状態にし直すので、タップの処理の中で呼ぶ（画面設計書 2.4）
      onConfirm={() => void confirmSuggestedSwitch()}
    />
  );
}

function SearchCheckinConfirm({ model }: { model: Extract<Model, { id: "S06-M1" }> }) {
  const armed = useArmed("S06-M1");
  return (
    <ConfirmBody
      lines={[
        `${model.userName} の ${model.ticketNos.join("、")} を、${model.receptionName} で、検索からチェックインします`,
      ]}
      confirmLabel="チェックイン"
      armed={armed}
      onConfirm={() => void confirmSearchCheckin()}
    />
  );
}

// ───────── S08-M1 取り消しの確認 ─────────

const REASONS = [
  { kind: "mistake", label: "誤操作" },
  { kind: "wrong_person", label: "別人だった" },
  { kind: "other", label: "その他" },
] as const;

function CancelConfirm({ model }: { model: Extract<Model, { id: "S08-M1" }> }) {
  const armed = useArmed("S08-M1");
  // 選んだチケットと理由は、シートの中の入力として、ここで持つ。最初はすべてに印を付けておく
  const [unchecked, setUnchecked] = useState<ReadonlySet<string>>(new Set());
  const [kind, setKind] = useState<CancelReason["kind"] | null>(null);
  const [text, setText] = useState("");

  // 開いている間に、届いた記録で根拠でなくなったチケットは、一覧から消える。選んだチケットからも外す
  const tokens = model.cancellable.map((ticket) => ticket.ticketToken).filter((token) => !unchecked.has(token));
  const reason: CancelReason | null =
    kind === null ? null : kind === "other" ? (text.trim() === "" ? null : { kind, text }) : { kind };

  const toggle = (token: string) => {
    const next = new Set(unchecked);
    if (!next.delete(token)) next.add(token);
    setUnchecked(next);
  };

  return (
    <ConfirmBody
      lines={[
        model.receptionName === null
          ? `${model.userName} の、下で選んだチケットのチェックインを取り消します`
          : `${model.userName} の、下で選んだチケットのチェックインを、${model.receptionName} で取り消します`,
      ]}
      confirmLabel="取り消す"
      armed={armed}
      disabled={reason === null || tokens.length === 0}
      onConfirm={() => {
        if (reason !== null) void confirmCancel(tokens, reason);
      }}
    >
      <fieldset class="flex flex-col border-t border-divider pt-2">
        <legend class="sr-only">対象のチケット</legend>
        {model.cancellable.map((ticket) => (
          <label key={ticket.ticketToken} class="flex min-h-12 items-center gap-3 px-2 font-bold">
            <input
              type="checkbox"
              class="choice-input"
              checked={!unchecked.has(ticket.ticketToken)}
              onChange={() => toggle(ticket.ticketToken)}
            />
            <span class="wrap-anywhere">
              {ticket.ticketNo}
              {ticket.ticketType !== null && ` ${ticket.ticketType}`}
            </span>
          </label>
        ))}
      </fieldset>
      <fieldset class="flex flex-col border-t border-divider pt-2">
        <legend class="sr-only">理由</legend>
        {REASONS.map((option) => (
          <label key={option.kind} class="flex min-h-12 items-center gap-3 px-2">
            <input
              type="radio"
              name="cancel-reason"
              class="choice-input"
              checked={kind === option.kind}
              onChange={() => setKind(option.kind)}
            />
            {option.label}
          </label>
        ))}
        {kind === "other" && (
          <textarea
            class="mt-1 min-h-13 rounded-pressable border border-outline bg-surface px-3 py-3 text-4"
            aria-label="理由"
            rows={2}
            // 2,000 文字を超えては入力できないようにする。サーバが、それを超える記録を受け付けない。
            // 上限で切った端に残るサロゲートの片方など、保存できない文字も除く
            maxLength={REASON_TEXT_MAX}
            value={text}
            onInput={(event) => setText(reasonTextOf(event.currentTarget.value))}
          />
        )}
      </fieldset>
    </ConfirmBody>
  );
}

// ───────── S09-D1 ログアウトの確認 ─────────

function LogoutConfirm({ model }: { model: Extract<Model, { id: "S09-D1" }> }) {
  const armed = useArmed("S09-D1");
  return (
    <ConfirmBody
      lines={[
        "この端末のデータを消してログアウトします",
        model.unsent ? "未同期の記録も消えます" : null,
        model.status === "offline" ? "オフラインです。再ログインとデータの取得にはネットワークが必要です" : null,
        model.status === "failed"
          ? "同期に失敗しています。同期できるようになるまで、再ログインとデータの取得ができないおそれがあります"
          : null,
      ]}
      confirmLabel="ログアウト"
      armed={armed}
      onConfirm={() => void logout()}
    />
  );
}

// ───────── S09-D2 高速受付とリハーサルモードの切り替えの確認 ─────────

const MODE_CHANGE: Record<ModeChange, { lines: string[]; confirmLabel: string }> = {
  rehearsalOn: { lines: ["リハーサルモードに切り替えますか？"], confirmLabel: "切り替える" },
  rehearsalOff: { lines: ["通常モードに戻しますか？"], confirmLabel: "戻す" },
  fastCheckinOn: {
    lines: [
      "高速受付に切り替えますか？",
      "高速受付にすると通常時とは異なりQR読み取り成功後、即座に受け付けが完了します。",
    ],
    confirmLabel: "切り替える",
  },
};

function ModeChangeConfirm({ model }: { model: Extract<Model, { id: "S09-D2" }> }) {
  const armed = useArmed(`S09-D2:${model.change}`);
  return <ConfirmBody {...MODE_CHANGE[model.change]} armed={armed} onConfirm={() => void confirmModeChange()} />;
}

// ───────── S03-D1 通常受付の確認、S04-D1 リハーサルモードの知らせ ─────────

/**
 * 読み取ったチケットの持ち主を出して、受付を続けるかを確かめる。読み取りのたびに出るので、注意を要する操作の
 * 確認（画面設計書 2.5）とは違い、確定は通常の主ボタンにして、開いた直後から押せる
 */
function QrCheckinConfirm({ model }: { model: Extract<Model, { id: "S03-D1" }> }) {
  return (
    <>
      <div class="flex flex-col gap-1">
        <p class="text-1 leading-9 font-bold wrap-anywhere">{model.userName}</p>
        {model.name !== "" && <p class="font-bold text-ink-sub wrap-anywhere">{model.name}</p>}
        <p class="text-5 text-ink-sub wrap-anywhere">
          {model.ticketNo} {model.ticketType}
        </p>
      </div>
      <p>この人の受付を続けますか？</p>
      <div class="flex flex-col gap-3 pt-2">
        {/* 音を鳴らせる状態にし直すので、タップの処理の中で呼ぶ（画面設計書 2.4） */}
        <Button kind="primary" disabled={busy.value} onClick={() => void confirmQrCheckin()}>
          続ける
        </Button>
        <Button kind="outline" disabled={busy.value} onClick={cancelQrCheckin}>
          やめる
        </Button>
      </div>
    </>
  );
}

function RehearsalNotice() {
  return (
    <>
      <p class="text-2 font-bold">リハーサルモードです</p>
      <p class="text-5 text-ink-sub">この受付は記録に残りません</p>
      <div class="pt-2">
        <Button kind="primary" onClick={closeOverlay}>
          OK
        </Button>
      </div>
    </>
  );
}

function Content({ model, closing }: { model: Model; closing: boolean }) {
  switch (model.id) {
    case "S03-D1":
      return (
        <Modal kind="dialog" closing={closing} onDismiss={cancelQrCheckin}>
          <QrCheckinConfirm model={model} />
        </Modal>
      );
    case "S04-D1":
      return (
        <Modal kind="dialog" closing={closing}>
          <RehearsalNotice />
        </Modal>
      );
    case "S09-D2":
      return (
        <Modal kind="dialog" closing={closing}>
          <ModeChangeConfirm model={model} />
        </Modal>
      );
    case "S02-M1":
      // 一覧と確認は、同じ <dialog> の中身を切り替える。確認では、つまみを出さず、下に引いても閉じない
      return (
        <Modal kind="sheet" closing={closing} pullable={model.step === "list"}>
          {model.step === "list" ? <ReceptionList model={model} /> : <ReceptionConfirm model={model} />}
        </Modal>
      );
    case "S04-M1":
      return (
        <Modal kind="sheet" closing={closing} pullable half>
          <Reference model={model} />
        </Modal>
      );
    case "S04-M2":
      return (
        <Modal kind="sheet" closing={closing}>
          <SwitchConfirm model={model} />
        </Modal>
      );
    case "S06-M1":
      return (
        <Modal kind="sheet" closing={closing}>
          <SearchCheckinConfirm model={model} />
        </Modal>
      );
    case "S08-M1":
      return (
        <Modal kind="sheet" closing={closing}>
          <CancelConfirm model={model} />
        </Modal>
      );
    case "S09-D1":
      return (
        <Modal kind="dialog" closing={closing}>
          <LogoutConfirm model={model} />
        </Modal>
      );
  }
}

/** 開いているシートかダイアログを描く。閉じた後は、閉じる動きが終わるまで、最後の中身を出し続ける */
export function OverlayHost() {
  const live = currentModel();
  const held = useRef<Model | null>(null);
  const [, redraw] = useState(0);
  if (live !== null) held.current = live;
  const closing = live === null && held.current !== null;

  useEffect(() => {
    if (!closing) return;
    const timer = setTimeout(
      () => {
        held.current = null;
        redraw((count) => count + 1);
      },
      prefersReducedMotion() ? 0 : LEAVE_MS,
    );
    return () => clearTimeout(timer);
  }, [closing]);

  const model = live ?? held.current;
  // key を id にして、別のシートに替わったら <dialog> を作り直す
  return model === null ? null : <Content key={model.id} model={model} closing={closing} />;
}
