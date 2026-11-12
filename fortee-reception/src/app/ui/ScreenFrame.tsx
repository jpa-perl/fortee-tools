import type { ComponentChildren } from "preact";

type Props = {
  /** 上部固定 */
  header?: ComponentChildren;
  /** 本文 */
  children: ComponentChildren;
  /** 下部固定 */
  footer?: ComponentChildren;
};

/**
 * 画面の枠（Design Doc 6.12）。上部固定、本文、下部固定を縦に並べた列として組む。
 * 固定の要素は高さを保ち、本文の領域だけを縮めてスクロールさせる。
 * 固定の要素を本文の上に重ねて置く作り（position: fixed）にはしない。
 * 高さが足りなくなっても、要素が重なって押せなくなったり、はみ出して見えなくなったりしないためである
 */
export function ScreenFrame({ header, children, footer }: Props) {
  return (
    <div class="flex h-dvh flex-col">
      {header !== undefined && <header class="safe-top shrink-0 border-b border-divider bg-surface">{header}</header>}
      <main class="min-h-0 flex-1 overflow-y-auto">{children}</main>
      {footer !== undefined && (
        <footer class="safe-bottom shrink-0 border-t border-divider bg-surface">{footer}</footer>
      )}
    </div>
  );
}
