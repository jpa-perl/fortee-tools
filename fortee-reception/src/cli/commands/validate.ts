import { formatConfigErrors, loadConfigFile } from "../config-file.ts";
import { CliError } from "../errors.ts";
import type { Target } from "../target.ts";

// validate（Design Doc 8.1、8.7、FR-4, 46）。設定ファイルを読み、Design Doc 4.2 の検証と、
// テンプレートの部分集合と名前の検証（4.6）を行い、誤りをすべて列挙してから非ゼロで終わる。
// conference.environment と --env の照合も、ほかの誤りと一緒に列挙する。D1 と KV には触れない。
// CSV の列の存在は取り込み（FR-43）で、種別名は公開（Design Doc 9.4）で確かめる。

export async function validate(target: Target, log: (line: string) => void): Promise<void> {
  const loaded = await loadConfigFile(target.configPath, target.env);
  if (!loaded.ok) {
    throw new CliError(
      `設定ファイル ${target.configPath} に誤りがあります（${loaded.errors.length} 件）\n${formatConfigErrors(loaded.errors)}`,
    );
  }
  const { config } = loaded;
  const periods = config.receptions.reduce((sum, reception) => sum + reception.periods.length, 0);
  log(`設定ファイル ${target.configPath} に誤りはありません`);
  log(`  カンファレンス: ${config.conference.name}（${config.conference.slug}、${config.conference.timezone}）`);
  log(`  イベント: ${config.events.length} 個、受付: ${config.receptions.length} 個（期間 ${periods} 個）`);
}
