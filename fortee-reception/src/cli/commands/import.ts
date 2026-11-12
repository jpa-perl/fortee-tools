import { readFile } from "node:fs/promises";
import type { ConfigBody } from "../../core/config-file.ts";
import { formatOffsetIso } from "../../core/time.ts";
import { CliError } from "../errors.ts";
import { importForteeZip } from "../fortee-zip.ts";
import { answerColumnsOf, describeEvent, eventOf } from "../references.ts";
import type { Target } from "../target.ts";
import { profileUrlTokensPath, readProfileUrlTokens, writeSnapshot } from "../workdir.ts";

// import（Design Doc 8.1、8.3、FR-43）。fortee のダウンロード ZIP から、1 つのイベントのスナップショットを作り、
// 作業ディレクトリ（.work/<環境名>/snapshots/{eventId}.json）に置く。D1 と KV には触れない。
// 同じ作業ディレクトリに profile_url_token の補正ファイルがあれば、読む。
// 再取り込みはイベント単位で、そのイベントのスナップショットだけを置き換える。
// 参加者の情報は、ログに出さない。

export type ImportOptions = {
  /** イベントの key か id */
  event: string;
  /** ZIP のパス */
  zip: string;
};

export type ImportDeps = {
  now: () => number;
  log: (line: string) => void;
  warn: (line: string) => void;
};

export async function importZip(target: Target, config: ConfigBody, options: ImportOptions, deps: ImportDeps): Promise<void> {
  const event = eventOf(config, options.event, "--event");

  let zip: Uint8Array;
  try {
    zip = await readFile(options.zip);
  } catch {
    throw new CliError(`ZIP ${options.zip} を読めません`);
  }

  const result = importForteeZip({
    zip,
    slug: config.conference.slug,
    eventId: event.id,
    answerColumns: answerColumnsOf(config, event.id),
    profileUrlTokens: await readProfileUrlTokens(target, event.id),
    now: deps.now(),
  });
  if (!result.ok) {
    // 補正ファイルの置き場所は、誤りの文言ではなくここで出す。fortee-zip はファイルを知らない
    const needsCorrection = result.errors.some((error) => error.includes("補正ファイル"));
    throw new CliError(
      `${describeEvent(event)} に ZIP を取り込めません（${result.errors.length} 件）。スナップショットは変えていません\n` +
        result.errors.map((error) => `  ${error}`).join("\n") +
        (needsCorrection ? `\n補正ファイル: ${profileUrlTokensPath(target, event.id)}` : ""),
    );
  }
  for (const warning of result.warnings) deps.warn(`警告: ${warning}`);

  const path = await writeSnapshot(target, result.snapshot);

  // 取り込みの結果（Design Doc 8.3 の 5）。CSV にイベントの列がないので、ZIP とイベントの対応は、
  // 管理者がこの結果を fortee のそのイベントのチケット種別と見比べて確かめる（PRD 9 章）
  const { summary, snapshot } = result;
  deps.log(`取り込みました: ${describeEvent(event)} イベント ID ${event.id}`);
  deps.log(`  取り込んだ行: ${summary.imported}`);
  deps.log(`  未発券として除いた行: ${summary.unissued}`);
  deps.log("  チケット種別ごとの行の数と、チケット番号の接頭辞:");
  for (const type of summary.ticketTypes) {
    const prefixes = type.prefixes.map((prefix) => (prefix === "" ? "（「-」なし）" : prefix)).join("、");
    deps.log(`    ${type.ticketType}: ${type.count} 行、接頭辞 ${prefixes}`);
  }
  if (summary.ticketTypes.length === 0) deps.log("    （取り込んだ行がありません）");
  deps.log(`  取り込んだ列: ${snapshot.columns.length === 0 ? "（なし）" : snapshot.columns.join("、")}`);
  deps.log(`  版（取り込み日時）: ${snapshot.version}（${formatOffsetIso(snapshot.version, config.conference.timezone)}）`);
  deps.log(`  スナップショット: ${path}`);
  deps.log("チケット種別と接頭辞が、fortee のこのイベントのものであることを確かめてください。CLI は、ZIP とイベントの対応を検証しません");
}
