import { CliError } from "../errors.ts";
import { assertMarksNotMismatched, readMarks, writeMissingMarks } from "../marks.ts";
import type { Target } from "../target.ts";
import { applyMigrations, pendingMigrations } from "../wrangler.ts";

// migrate（Design Doc 8.1）。D1 にマイグレーションを適用し、D1 と KV に環境の印がなければ書く。
// 環境を作る手順（dev-setup 5 章）で、D1 と KV に最初に触れるコマンドである。
// v1 以後は、Design Doc 9.6 の条件（1 つ前のリリースのコードが動く変更）を満たすことを確かめてから実行する。

export async function migrate(target: Target, log: (line: string) => void): Promise<void> {
  // ある印は、適用の前に照合する。最初のマイグレーションの前で meta の表がないときは、D1 の印を照合せずに進む
  assertMarksNotMismatched(await readMarks(target), target);

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
