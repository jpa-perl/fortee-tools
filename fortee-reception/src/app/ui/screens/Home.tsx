import type { ComponentChildren } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import {
  attachCameraVideo,
  nextFromResult,
  openHistory,
  openReceptionSheet,
  openReference,
  openSearch,
  openSwitchConfirm,
  retryCamera,
  startScan,
} from "../../commands/index.ts";
import {
  type CameraState,
  dataVersions,
  formatClock,
  type HomeMode,
  receptionCard,
  recentOperations,
  type ResultView,
  resultView,
  scanBanner,
} from "../../state/index.ts";
import { Button } from "../Button.tsx";
import { isAndroid, isIos } from "../env.ts";
import { Header } from "../Header.tsx";
import {
  CameraIcon,
  ChevronRightIcon,
  ResultCheckIcon,
  ResultCrossIcon,
  ResultExclamationIcon,
  ResultQrIcon,
  ResultSwapIcon,
  ScanFrame,
} from "../icons.tsx";
import { receptionEmphasized } from "../Notice.tsx";
import { RecordRow } from "../RecordRow.tsx";
import { ScreenFrame } from "../ScreenFrame.tsx";
import { TicketList } from "../TicketList.tsx";

// ホーム（S02〜S04）。停止中、読み取り中、結果の 3 つの状態を持つ 1 つの画面。
//
// 本文の先頭に、どの状態でも同じ位置と高さの「上の領域」を置く（styles.css の .home-top）。上の領域は止めて、
// その下だけをスクロールさせる。表示領域の高さが足りないとき（short:）は、上の領域も、その下と一緒に、
// ひと続きの本文としてスクロールさせる（画面設計書 S02〜S04）

/** 直近の記録として描く行の上限。収まる件数は、この中から、描いた結果を測って決める */
const RECENT_MAX = 20;
/** 表示領域の高さが足りないときに、停止中（S02）で出す件数 */
const RECENT_SHORT = 3;

/** 本文の枠。上の領域と、その下 */
function HomeBody({ top, children, scrollKey }: { top: ComponentChildren; children?: ComponentChildren; scrollKey?: unknown }) {
  const outer = useRef<HTMLElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  // 結果を出したときは、先頭から表示する
  useLayoutEffect(() => {
    outer.current?.scrollTo(0, 0);
    inner.current?.scrollTo(0, 0);
  }, [scrollKey]);
  return (
    <main ref={outer} class="flex min-h-0 flex-1 flex-col short:block short:overflow-y-auto">
      {top}
      {/* 押せる要素のない本文も、キーボードでスクロールできるように、フォーカスできる要素にする */}
      <div ref={inner} tabIndex={0} class="flex min-h-0 flex-1 flex-col overflow-y-auto short:overflow-visible">
        {children}
      </div>
    </main>
  );
}

// ───────── 直近の記録（S02、S03） ─────────

/**
 * この端末で行った操作を、新しい順に、領域に収まる件数だけ出す。本文はスクロールさせない。
 * 行の高さは一定でない（チケット番号が 2 行目に回る行がある）ので、描いた結果を測って、収まらない行を隠す
 */
function RecentRecords({ footer }: { footer?: ComponentChildren }) {
  const operations = recentOperations.value.slice(0, RECENT_MAX);
  const list = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState(RECENT_MAX);

  useLayoutEffect(() => {
    const element = list.current;
    if (element === null) return;
    const measure = () => {
      const limit = element.getBoundingClientRect().bottom + 0.5;
      let count = 0;
      for (const row of Array.from(element.children)) {
        // 高さが足りないときに CSS で消している行は、数えない
        if (row.getBoundingClientRect().height === 0) break;
        if (row.getBoundingClientRect().bottom > limit) break;
        count++;
      }
      setFit(count);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [operations.length, operations[0]?.opId]);

  if (operations.length === 0) return <>{footer}</>;
  return (
    <>
      {/* 1 件も収まらないときは、見出しも出さない */}
      <h2 class={`shrink-0 px-4 pt-4 pb-2 text-5 font-bold text-ink-sub ${fit === 0 ? "invisible" : ""}`}>直近の記録</h2>
      {/* 中身の高さまでで、領域に収まらなければ縮む。「履歴をすべて見る」は、最後の行のすぐ下に続く */}
      <div ref={list} class="min-h-0 shrink overflow-hidden border-t border-divider short:shrink-0 short:overflow-visible">
        {operations.map((operation, i) => (
          <RecordRow
            key={operation.opId}
            operation={operation}
            hidden={i >= fit}
            class={i >= RECENT_SHORT ? "short:hidden" : ""}
          />
        ))}
      </div>
      {footer}
    </>
  );
}

// ───────── S02 停止中 ─────────

function ReceptionCard() {
  const { reception, manual, period } = receptionCard();
  // 強調している間は、地の色を付けない。地のクラスは、強調の色より優先されるためである
  const ground = receptionEmphasized() ? "emphasis" : reception === null ? "bg-inactive-surface" : "bg-surface";
  return (
    <div class="home-top flex shrink-0 flex-col p-4">
      <button
        type="button"
        class={
          `flex flex-1 items-center gap-3 rounded-pressable border border-outline px-5 py-4 text-left ${ground}`
        }
        onClick={openReceptionSheet}
      >
        {/* 読み上げの名前。見えている文字（受付名など）に続けて読まれる */}
        <span class="sr-only">受付を切り替える</span>
        {reception === null ? (
          <span class="flex-1 text-2 font-bold text-ink-sub">受付なし</span>
        ) : (
          <span class="flex min-w-0 flex-1 flex-col gap-1">
            <span class="text-2 font-bold wrap-anywhere">{reception.name}</span>
            <span class="flex flex-wrap items-center gap-x-2 font-bold text-ink-sub">
              {manual ? (
                <span class="rounded-pressable bg-warn px-2 text-6 text-on-warn">手動</span>
              ) : (
                <span class="text-6">自動</span>
              )}
              <span>{period === null ? "期間外" : `${formatClock(period.start)}〜${formatClock(period.end)}`}</span>
            </span>
          </span>
        )}
        <ChevronRightIcon class="size-6 shrink-0 text-ink-sub" />
      </button>
    </div>
  );
}

function Idle() {
  const noReception = receptionCard().reception === null;
  return (
    <ScreenFrame
      ownScroll
      header={<Header reception={false} menu />}
      footer={
        <>
          <Button kind="outline" onClick={openSearch}>
            検索
          </Button>
          {/* 音を鳴らせる状態にするので、タップの処理の中で呼ぶ（画面設計書 2.4）。受付なしでは押せない（FR-7） */}
          <Button kind="primary" disabled={noReception} onClick={startScan}>
            QR コード読み取り
          </Button>
        </>
      }
    >
      <HomeBody top={<ReceptionCard />}>
        <RecentRecords
          footer={
            <div class="shrink-0 p-4">
              <Button kind="outline" onClick={openHistory}>
                履歴をすべて見る
              </Button>
            </div>
          }
        />
      </HomeBody>
    </ScreenFrame>
  );
}

// ───────── S03 読み取り中 ─────────

function CameraArea({ camera }: { camera: CameraState }) {
  if (camera === "denied") {
    // 映像の代わりに、手順を出す。収まらなければ、上の領域を下に伸ばす
    const ios = isIos();
    const android = isAndroid();
    return (
      <div class="home-top flex shrink-0 flex-col justify-center gap-3 bg-surface p-4">
        <p class="text-2 font-bold">カメラを使えません</p>
        <div class="text-5 text-ink-sub">
          {(ios || !android) && <p>設定 &gt; アプリ &gt; Safari &gt; カメラ</p>}
          {(android || !ios) && <p>Chrome &gt; 設定 &gt; サイトの設定 &gt; カメラ</p>}
        </div>
        <div class="flex flex-wrap gap-3">
          <Button kind="outline" inline onClick={retryCamera}>
            もう一度試す
          </Button>
          <Button kind="outline" inline onClick={openSearch}>
            検索で続ける
          </Button>
        </div>
      </div>
    );
  }
  return (
    <div class="home-top relative shrink-0 overflow-hidden bg-camera text-on-camera">
      {/* 映像を、縦横比を保ったまま、上の領域に隙間なく収める。読み取るのは、ここに出ている範囲だけ */}
      <video ref={attachCameraVideo} class="absolute inset-0 size-full object-cover" playsInline muted autoplay />
      <div class="absolute inset-0 flex items-center justify-center p-6">
        {camera === "requesting" ? (
          <CameraIcon class="size-16" label="カメラの許可待ち" />
        ) : (
          <ScanFrame class="aspect-square h-full max-w-full" />
        )}
      </div>
      {scanBanner.value && (
        <p class="absolute inset-x-4 top-4 rounded-pressable bg-surface px-4 py-3 text-center font-bold text-ink" role="status">
          チケットの QR ではありません
        </p>
      )}
    </div>
  );
}

function Scanning({ camera }: { camera: CameraState }) {
  return (
    <ScreenFrame
      ownScroll
      header={<Header back="終了" />}
      // 「検索」は、左に寄せ、全幅にしない。結果の主ボタンを続けて叩いたときに、押されにくくする。
      // カメラの使用が拒否されたときは置かず、上の領域の「検索で続ける」を使う
      footer={
        camera === "denied" ? undefined : (
          <div class="flex">
            <Button kind="outline" inline onClick={openSearch}>
              <span class="px-6">検索</span>
            </Button>
          </div>
        )
      }
    >
      <HomeBody top={<CameraArea camera={camera} />}>
        {/* 高さが足りないときは、直近の記録を出さず、本文をカメラの映像だけにする */}
        <div class="flex min-h-0 flex-1 flex-col short:hidden">
          <RecentRecords />
        </div>
      </HomeBody>
    </ScreenFrame>
  );
}

// ───────── S04 結果 ─────────

const TONE = {
  success: "bg-ok text-on-ok",
  caution: "bg-warn text-on-warn",
  reject: "bg-reject text-on-reject",
} as const;

type Band = { tone: keyof typeof TONE; icon: ComponentChildren; title: string; lines: string[]; next: string };

const ICON = "size-16";

/** 結果の帯と、下部の主ボタンの文言（画面設計書 2.4 の表） */
function bandOf(view: ResultView): Band {
  const next = "次へ";
  switch (view.kind) {
    case "success":
      return { tone: "success", icon: <ResultCheckIcon class={ICON} />, title: "チェックインしました", lines: [], next };
    case "continue":
      return {
        tone: "caution",
        icon: <ResultQrIcon class={ICON} />,
        title: "続けて読み取り",
        lines: [`${view.remainingEventNames.join("、")}のチケットを 1 枚読み取ってください`],
        next: "続けて読み取る",
      };
    case "alreadyDone":
      return {
        tone: "caution",
        icon: <ResultExclamationIcon class={ICON} />,
        title: "チェックイン済み",
        lines: view.basis === null ? [] : [`${formatClock(view.basis.time)} ${view.basis.receptionName ?? ""}`.trim()],
        next,
      };
    case "suggestSwitch": {
      const name = view.suggestion?.receptionName ?? "";
      return {
        tone: "caution",
        icon: <ResultSwapIcon class={ICON} />,
        title: "別の受付のチケット",
        lines: [`${name}で受け付けます`, ...(view.suggestion?.outOfPeriod === true ? [`${name}は期間外です`] : [])],
        next: "切り替えずに次へ",
      };
    }
    case "rejected":
      return {
        tone: "reject",
        icon: <ResultCrossIcon class={ICON} />,
        title: "受け付けられません",
        lines: view.rejectMessage === null ? [] : [view.rejectMessage],
        next,
      };
    case "noTicketToCheckIn":
      return {
        tone: "reject",
        icon: <ResultCrossIcon class={ICON} />,
        title: "受け付けられません",
        lines: [`${view.missingEventNames.join("、")}のチケットがありません`],
        next,
      };
    case "outOfScope":
      return { tone: "reject", icon: <ResultCrossIcon class={ICON} />, title: "対象外のチケット", lines: [], next };
  }
}

const NOT_FOUND: Band = {
  tone: "reject",
  icon: <ResultCrossIcon class={ICON} />,
  title: "データにないチケット",
  lines: ["キャンセル済みか、データ取得後の購入です"],
  next: "次へ",
};

/** 帯。上の領域を結果の色で塗り、アイコン、結果名、帯の 1 行を出す。色だけで区別しない */
function BandArea({ band }: { band: Band }) {
  // NFR-1 の計測の終点。記録のトランザクションが確定した後に、結果の帯を描いた時点（Design Doc 11 章）。
  // 帯は、結果ごとに作り直される（key）ので、結果を出すたびに 1 回だけ付く
  useEffect(() => {
    try {
      performance.clearMarks("checkin:result");
      performance.mark("checkin:result");
      // 読み取りから判定表示まで。始点は、デコードに渡したコマを映像から取り出した時点（services/camera.ts）。
      // 検索からのチェックインでは始点の印がなく、測れない（例外になり、下で捨てる）
      performance.clearMeasures("checkin:scan-to-result");
      performance.measure("checkin:scan-to-result", "checkin:frame", "checkin:result");
    } catch {
      // 計測の印は、付けられなくてもよい
    }
  }, []);
  return (
    <div class={`home-top flex shrink-0 flex-col items-center justify-center gap-1 px-4 py-4 text-center ${TONE[band.tone]}`}>
      {band.icon}
      <h1 class="text-1 leading-9 font-bold wrap-anywhere">{band.title}</h1>
      {band.lines.map((line) => (
        <p key={line} class="font-bold wrap-anywhere">
          {line}
        </p>
      ))}
    </div>
  );
}

function ResultDetail({ view }: { view: ResultView }) {
  return (
    <>
      <div class="flex flex-col gap-3 p-4">
        <div>
          <p class="text-1 leading-9 font-bold wrap-anywhere">{view.userName}</p>
          {view.name !== "" && <p class="font-bold text-ink-sub wrap-anywhere">{view.name}</p>}
        </div>
        {/* 済みの詳細。帯の 1 行と同じ記録の、操作者と端末名 */}
        {view.basis !== null && (
          <p class="text-5 text-ink-sub wrap-anywhere">
            {view.basis.operatorName}・{view.basis.deviceName}
          </p>
        )}
        {view.suggestion !== null && (
          <Button kind="caution" onClick={openSwitchConfirm}>
            {view.suggestion.receptionName}に切り替えて判定
          </Button>
        )}
      </div>
      <div class="border-y border-divider bg-surface px-4 pt-1 pb-4">
        <TicketList groups={view.groups} />
      </div>
    </>
  );
}

function DataVersions() {
  return (
    <div class="p-4">
      <h2 class="pb-2 text-5 font-bold text-ink-sub">データの取得日時</h2>
      <ul>
        {dataVersions().map((entry) => (
          <li key={entry.eventId} class="wrap-anywhere">
            {entry.eventName} {entry.version === null ? "" : formatClock(entry.version)}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** 結果ごとに変わる値。次の判定や判定し直しで結果が変わったら、先頭に戻し、回答の開閉もすべて閉じた状態に戻す */
let resultSerial = 0;
const resultSerials = new WeakMap<object, number>();
function serialOf(mode: object): number {
  let serial = resultSerials.get(mode);
  if (serial === undefined) {
    serial = ++resultSerial;
    resultSerials.set(mode, serial);
  }
  return serial;
}

function Result({ mode }: { mode: HomeMode }) {
  const view = resultView();
  const band = view === null ? NOT_FOUND : bandOf(view);
  const serial = serialOf(mode);
  return (
    <ScreenFrame
      ownScroll
      header={<Header />}
      footer={
        <>
          {view !== null && (
            <Button kind="outline" onClick={openReference}>
              参考情報
            </Button>
          )}
          {/* 音を鳴らせる状態にし直すので、タップの処理の中で呼ぶ（画面設計書 2.4） */}
          <Button kind="primary" onClick={nextFromResult}>
            {band.next}
          </Button>
        </>
      }
    >
      <HomeBody top={<BandArea key={serial} band={band} />} scrollKey={serial}>
        {view === null ? <DataVersions /> : <ResultDetail key={serial} view={view} />}
      </HomeBody>
    </ScreenFrame>
  );
}

export function Home({ mode }: { mode: HomeMode }) {
  switch (mode.kind) {
    case "idle":
      return <Idle />;
    case "scanning":
      return <Scanning camera={mode.camera} />;
    default:
      return <Result mode={mode} />;
  }
}
