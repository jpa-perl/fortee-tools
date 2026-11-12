import type { ComponentChildren } from "preact";
import { WarningIcon } from "./icons.tsx";

// ボタン（画面設計書 2.2、2.5）。色は操作の種類を表す。枠は、押せる要素にだけ付ける（画面設計書 2.9）。

type Kind =
  /** 主ボタン。通常色の塗り */
  | "primary"
  /** それ以外の通常の操作。枠線 */
  | "outline"
  /** 注意を要する操作。赤の枠線（塗らない）と ⚠（FR-32） */
  | "caution"
  /** 確定。赤の塗り（FR-33） */
  | "confirm";

const KIND: Record<Kind, string> = {
  primary: "border-primary bg-primary text-on-primary",
  outline: "border-outline bg-surface text-ink",
  caution: "border-caution bg-surface text-caution",
  confirm: "border-confirm bg-confirm text-on-confirm",
};

type Props = {
  kind: Kind;
  onClick: () => void;
  disabled?: boolean;
  /** 幅を中身に合わせる。省くと全幅 */
  inline?: boolean;
  children: ComponentChildren;
};

const BASE =
  "flex min-h-13 items-center justify-center gap-2 rounded-pressable px-4 py-2 text-3 font-bold " +
  "disabled:border-disabled-surface disabled:bg-disabled-surface disabled:text-disabled";

export function Button({ kind, onClick, disabled, inline, children }: Props) {
  return (
    <button
      type="button"
      class={`${BASE} ${kind === "caution" ? "border-2" : "border"} ${KIND[kind]} ${inline === true ? "" : "w-full"}`}
      disabled={disabled === true}
      onClick={onClick}
    >
      {kind === "caution" && <WarningIcon class="size-5 shrink-0" />}
      {children}
    </button>
  );
}
