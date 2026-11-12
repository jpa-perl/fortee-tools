import type { ComponentChildren } from "preact";

// アイコン。単純な線の SVG を、ここにまとめる。アイコンのライブラリは入れない（フロントエンド 3 章）。
// 文字を添えずに意味を表すアイコンには、label でアクセシブルな名前を付ける（画面設計書 2.9）。
// label を渡さなければ、飾りとして読み上げから外す。

type IconProps = {
  /** 大きさと色のクラス。色は currentColor で描く */
  class?: string;
  /** アクセシブルな名前。文字を添えているアイコンには付けない */
  label?: string;
};

function Svg({ class: className, label, children }: IconProps & { children: ComponentChildren }) {
  return (
    <svg
      class={className ?? "size-6"}
      role={label === undefined ? undefined : "img"}
      aria-label={label}
      aria-hidden={label === undefined ? true : undefined}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      {children}
    </svg>
  );
}

const CLOUD = "M17.5 19a4.5 4.5 0 0 0 .6-8.96A6 6 0 0 0 6.34 9.1 5 5 0 0 0 7 19h10.5Z";

/** 同期済み */
export const CloudCheckIcon = (props: IconProps) => (
  <Svg {...props}>
    <path d={CLOUD} />
    <path d="m9.5 13.5 2 2 3.5-3.5" />
  </Svg>
);

/** 未同期あり */
export const CloudUploadIcon = (props: IconProps) => (
  <Svg {...props}>
    <path d={CLOUD} />
    <path d="M12 16.5v-5m-2.25 2L12 11.25l2.25 2.25" />
  </Svg>
);

/** オフライン。unsent なら、未同期の印（点）を付ける */
export const CloudOffIcon = ({ unsent, ...props }: IconProps & { unsent?: boolean }) => (
  <Svg {...props}>
    <path d="M9.2 5.1A6 6 0 0 1 18.1 10a4.5 4.5 0 0 1 2.6 7.6M17 19H7a5 5 0 0 1-1.6-9.74" />
    <path d="m3 3 18 18" />
    {unsent === true && <circle cx="19" cy="5" r="3" fill="currentColor" stroke="none" />}
  </Svg>
);

/** 同期中、ログイン中、データ取得中。呼び出し側で回転させる */
export const SpinnerIcon = (props: IconProps) => (
  <Svg {...props}>
    <path d="M21 12a9 9 0 1 1-6.2-8.56" />
  </Svg>
);

/** 警告（再ログインが必要、同期の失敗）と、注意を要する操作の ⚠ */
export const WarningIcon = (props: IconProps) => (
  <Svg {...props}>
    <path d="M10.3 3.9 2.4 17.5A2 2 0 0 0 4.1 20.5h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
    <path d="M12 9.5v4" />
    <path d="M12 17h.01" />
  </Svg>
);

export const MenuIcon = (props: IconProps) => (
  <Svg {...props}>
    <path d="M4 6.5h16M4 12h16M4 17.5h16" />
  </Svg>
);

export const CloseIcon = (props: IconProps) => (
  <Svg {...props}>
    <path d="m5 5 14 14M19 5 5 19" />
  </Svg>
);

export const ChevronLeftIcon = (props: IconProps) => (
  <Svg {...props}>
    <path d="m15 5-7 7 7 7" />
  </Svg>
);

export const ChevronRightIcon = (props: IconProps) => (
  <Svg {...props}>
    <path d="m9 5 7 7-7 7" />
  </Svg>
);

export const ChevronDownIcon = (props: IconProps) => (
  <Svg {...props}>
    <path d="m5 9 7 7 7-7" />
  </Svg>
);

export const ChevronUpIcon = (props: IconProps) => (
  <Svg {...props}>
    <path d="m5 15 7-7 7 7" />
  </Svg>
);

/** 丸で囲まないチェック（S06 で選んだ行） */
export const CheckIcon = (props: IconProps) => (
  <Svg {...props}>
    <path d="m4.5 12.5 5 5 10-11" />
  </Svg>
);

export const SearchIcon = (props: IconProps) => (
  <Svg {...props}>
    <circle cx="11" cy="11" r="6.5" />
    <path d="m16 16 4.5 4.5" />
  </Svg>
);

/** 記録の行の「チェックイン」 */
export const CheckinIcon = (props: IconProps) => (
  <Svg {...props}>
    <path d="M3 12h11m-4-4 4 4-4 4" />
    <path d="M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4" />
  </Svg>
);

/** 記録の行の「取り消し」 */
export const UndoIcon = (props: IconProps) => (
  <Svg {...props}>
    <path d="M8 5 4 9l4 4" />
    <path d="M4 9h10a5 5 0 0 1 0 10h-3" />
  </Svg>
);

export const CameraIcon = (props: IconProps) => (
  <Svg {...props}>
    <path d="M4 8h3l1.5-2.5h7L17 8h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1Z" />
    <circle cx="12" cy="13" r="3.5" />
  </Svg>
);

/** iOS の共有のアイコン（S00 の手順） */
export const ShareIcon = (props: IconProps) => (
  <Svg {...props}>
    <path d="M12 15V3m-4 4 4-4 4 4" />
    <path d="M7 10H5.5a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h13a1 1 0 0 0 1-1v-9a1 1 0 0 0-1-1H17" />
  </Svg>
);

export const PlusSquareIcon = (props: IconProps) => (
  <Svg {...props}>
    <rect x="4" y="4" width="16" height="16" rx="3" />
    <path d="M12 8.5v7M8.5 12h7" />
  </Svg>
);

export const HomeAppIcon = (props: IconProps) => (
  <Svg {...props}>
    <rect x="4" y="4" width="16" height="16" rx="4" />
    <path d="m8.5 12.5 2.5 2.5 4.5-5" />
  </Svg>
);

// ───────── 結果の帯のアイコン（画面設計書 2.4）。丸で囲み、形で結果を見分ける ─────────

const Ring = () => <circle cx="12" cy="12" r="10" />;

/** 成功: チェック */
export const ResultCheckIcon = (props: IconProps) => (
  <Svg {...props}>
    <Ring />
    <path d="m7.5 12.5 3 3 6-6.5" />
  </Svg>
);

/** 済み: 感嘆符 */
export const ResultExclamationIcon = (props: IconProps) => (
  <Svg {...props}>
    <Ring />
    <path d="M12 6.5v7" />
    <path d="M12 17h.01" />
  </Svg>
);

/** 切替提案: 入れ替えの矢印 */
export const ResultSwapIcon = (props: IconProps) => (
  <Svg {...props}>
    <Ring />
    <path d="M7 9.5h10m-3-3 3 3-3 3" />
    <path d="M17 14.5H7m3-3-3 3 3 3" />
  </Svg>
);

/** 拒否、チケットなし、対象外、見つからない: バツ */
export const ResultCrossIcon = (props: IconProps) => (
  <Svg {...props}>
    <Ring />
    <path d="m8 8 8 8m0-8-8 8" />
  </Svg>
);

/** 続けて読み取り: QR コード */
export const ResultQrIcon = (props: IconProps) => (
  <Svg {...props}>
    <rect x="3.5" y="3.5" width="6" height="6" rx="1" />
    <rect x="14.5" y="3.5" width="6" height="6" rx="1" />
    <rect x="3.5" y="14.5" width="6" height="6" rx="1" />
    <path d="M14.5 14.5h2v2m4-2v6h-2.5m-3.500 0v-1.500" />
  </Svg>
);

// ───────── チケットの状態のマーク（画面設計書 2.9）。丸は、角丸ではなく形として描く ─────────

/** 今回済みと済み: 塗った丸にチェック。色は呼び出し側のクラスで決める（fill が currentColor） */
export function DoneMark({ class: className }: { class?: string }) {
  return (
    <svg class={className ?? "size-6"} viewBox="0 0 24 24" aria-hidden>
      <circle cx="12" cy="12" r="11" fill="currentColor" />
      <path d="m7 12.5 3.5 3.5 6.500-7" fill="none" stroke="var(--color-on-done)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  );
}

/** 未: 枠線だけの丸 */
export function TodoMark({ class: className }: { class?: string }) {
  return (
    <svg class={className ?? "size-6"} viewBox="0 0 24 24" aria-hidden>
      <circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="2" />
    </svg>
  );
}

/** 読み取り枠の四隅（S03） */
export function ScanFrame({ class: className }: { class?: string }) {
  return (
    <svg
      class={className}
      viewBox="0 0 100 100"
      fill="none"
      stroke="currentColor"
      stroke-width="3"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden
    >
      <path d="M2 18V8a6 6 0 0 1 6-6h10M82 2h10a6 6 0 0 1 6 6v10M98 82v10a6 6 0 0 1-6 6H82M18 98H8a6 6 0 0 1-6-6V82" />
    </svg>
  );
}
