import { notice, type NoticeLine } from "../state/index.ts";

function lineText(line: NoticeLine): string {
  switch (line.kind) {
    case "receptionChanged":
      return line.name === null ? "受付なしになりました" : `${line.name}になりました`;
    case "dataUpdated":
      return "データを更新しました";
    case "cancelled":
      return "取り消しました";
    case "cancelSkipped":
      return `${line.ticketNos.join("、")} は他の端末で操作されたため、取り消しませんでした`;
  }
}

/**
 * 知らせ（画面設計書 2.7、S08）。ヘッダのすぐ下に、本文に重ねて出す。数秒で自動的に消える。押しても消えない。
 * 高さを持たない枠の中に置くので、出ても本文の位置は変わらない。読み取り中（S03）では、カメラの映像に重なる。
 * 押す操作は受け取らず、下の要素に通す。ヘッダのない画面（bare）では、ヘッダがあるときと同じ位置に出す
 */
export function Notice({ bare }: { bare?: boolean }) {
  const current = notice.value;
  return (
    <div class="pointer-events-none relative z-10 shrink-0" role="status">
      {current !== null && (
        <div class={`absolute inset-x-4 flex justify-center ${bare === true ? "notice-bare" : "top-2"}`}>
          <p class="notice px-4 py-3 text-5 font-bold">
            {current.lines.map((line) => (
              <span class="block" key={line.kind}>
                {lineText(line)}
              </span>
            ))}
          </p>
        </div>
      )}
    </div>
  );
}

/** 受付の変化の知らせを出している間か。ヘッダの受付と受付のカードを強調する（画面設計書 2.7） */
export const receptionEmphasized = (): boolean =>
  notice.value?.lines.some((line) => line.kind === "receptionChanged") === true;
