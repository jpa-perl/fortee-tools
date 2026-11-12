import { CliError } from "../errors.ts";
import { assertMarksNotMismatched, readMarks, writeMissingMarks } from "../marks.ts";
import type { Target } from "../target.ts";
import { applyMigrations, pendingMigrations, unknownAppliedMigrations } from "../wrangler.ts";

// migrate（Design Doc 8.1）。D1 にマイグレーションを適用し、D1 と KV に環境の印がなければ書く。
// 環境を作る手順（production-setup 5.1）で、D1 と KV に最初に触れるコマンドである。
// 運用を始めた後の環境では、足すマイグレーションが、端末に残る更新前の受付アプリと、
// いまデプロイしてある Worker の動きを壊さないことを確かめてから実行する（Design Doc 9.6）。

export async function migrate(target: Target, log: (line: string) => void): Promise<void> {
  // ある印は、適用の前に照合する。最初のマイグレーションの前で meta の表がないときは、D1 の印を照合せずに進む
  assertMarksNotMismatched(await readMarks(target), target);

  // CLI が持たないマイグレーションが適用済みなら、既存のファイルを書き換えるか改名する前の D1 である。
  // そのまま適用すると、wrangler が名前の違うファイルを未適用と見て、表の重複で途中まで進んで止まる。
  // 運用の開始より前なら D1 を作り直す。運用を始めた後の D1 は作り直せない（Design Doc 9.6）
  const unknown = await unknownAppliedMigrations(target);
  if (unknown.length > 0) {
    throw new CliError(
      `D1 に、この CLI が持たないマイグレーションが適用されています（${unknown.join("、")}）。` +
        "既存のマイグレーションのファイルを書き換えるか改名する前に作った D1 です。" +
        (target.local
          ? "ローカルの D1 は、.wrangler/state を消して作り直してください"
          : "運用の開始より前なら、D1 を作り直してください（開発・環境構築手順書 6 章）。" +
            "運用を始めた後なら、CLI の版が D1 と合っているかを確かめてください"),
    );
  }

  await applyMigrations(target);

  // wrangler は、適用の確認で取り消されても、成功として終わる。終わり方では適用されたかが分からないので、
  // 未適用のマイグレーションが残っていないことを確かめてから、先へ進む
  const pending = await pendingMigrations(target);
  if (pending.length > 0) {
    throw new CliError(
      `マイグレーションが適用されていません（${pending.join("、")}）。適用を取り消したか、途中で止まっています。` +
        "環境の印は書いていません",
    );
  }

  // 適用の後に、印のないほうへ環境名を書く
  const marks = await readMarks(target);
  assertMarksNotMismatched(marks, target);
  const written = await writeMissingMarks(marks, target);

  if (written.d1) log(`D1 に環境の印（${target.env}）を書きました`);
  if (written.kv) log(`KV に環境の印（${target.env}）を書きました`);
  log(`migrate が終わりました（環境 ${target.env}）`);
}
