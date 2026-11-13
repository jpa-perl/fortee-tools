import type { ComponentChildren } from "preact";
import { Notice } from "./Notice.tsx";

type Props = {
  /** 上部固定 */
  header?: ComponentChildren;
  /** 本文 */
  children: ComponentChildren;
  /** 下部固定 */
  footer?: ComponentChildren;
  /**
   * 本文の領域を、この枠でスクロールさせない。ホーム（S02〜S04）は、上の領域を止めて、その下だけを
   * スクロールさせるので、本文の中を自分で組む
   */
  ownScroll?: boolean;
};

/**
 * 画面の枠（Design Doc 6.12）。上部固定、本文、下部固定を縦に並べた列として組む。
 * 固定の要素は高さを保ち、本文の領域だけを縮めてスクロールさせる。
 * 固定の要素を本文の上に重ねて置く作り（position: fixed）にはしない。
 * 高さが足りなくなっても、要素が重なって押せなくなったり、はみ出して見えなくなったりしないためである
 * ヘッダには position: sticky を付ける。この枠はスクロールしないので、配置は変わらない。iOS 27 は、ホーム画面に
 * 追加したアプリの上端にぼかしを重ねるが、上端に sticky か fixed の不透明な要素があると、その色で塗って、ぼかさない
 * （WebKit のバグ 325807。Apple の文書にない挙動で、iPhone 17 の実機で確かめた）。ホーム画面のアプリでは
 * env(safe-area-inset-top) が 0 になるので、安全領域だけを塗る帯では効かない
 */
export function ScreenFrame({ header, children, footer, ownScroll }: Props) {
  return (
    <div class="flex h-dvh flex-col">
      {/* ヘッダのない画面では、ステータスバーの裏を地の色で塗る（styles.css の .status-bar-fill） */}
      {header === undefined && <div aria-hidden="true" class="status-bar-fill bg-ground" />}
      {header !== undefined && <header class="safe-top sticky top-0 shrink-0 border-b border-divider bg-surface">{header}</header>}
      <Notice bare={header === undefined} />
      {ownScroll === true ? (
        children
      ) : (
        // 押せる要素のない本文も、キーボードでスクロールできるように、フォーカスできる要素にする
        <main tabIndex={0} class="min-h-0 flex-1 overflow-y-auto">
          {children}
        </main>
      )}
      {footer !== undefined && (
        <footer class="safe-bottom shrink-0 border-t border-divider bg-surface">
          <div class="flex flex-col gap-3 p-4">{footer}</div>
        </footer>
      )}
    </div>
  );
}
