import { type ConfigEvent, eventKeyOf, resolveEventRef } from "../core/config.ts";
import type { ConfigBody } from "../core/config-file.ts";
import { CliError } from "./errors.ts";

// 設定からの引き当て。取り込み、公開、プレビューが共通に使う。

/**
 * そのイベントについて、設定で参照する列（search.answers と display.answers の field）。重複を除いた、設定に書いた順。
 * スナップショットの answers と columns は、この列だけを持つ（FR-1, 43、Design Doc 4.3）
 */
export function answerColumnsOf(config: Pick<ConfigBody, "search" | "display">, eventId: string): string[] {
  const fields = [...config.search.answers, ...config.display.answers]
    .filter((answer) => answer.event === eventId)
    .map((answer) => answer.field);
  return [...new Set(fields)];
}

/** オプションで受けたイベントの指定（key か id）を、設定のイベントにする。指さなければ止まる */
export function eventOf(config: Pick<ConfigBody, "events">, ref: string, option: string): ConfigEvent {
  const id = resolveEventRef(config.events, ref);
  const event = config.events.find((candidate) => candidate.id === id);
  if (event === undefined) {
    const known = config.events.map((candidate) => eventKeyOf(candidate)).join("、");
    throw new CliError(`${option} の "${ref}" は、設定の events の key でも id でもありません（設定にあるイベント: ${known}）`);
  }
  return event;
}

/** イベントを人に示す書き方。「本編（main）」 */
export function describeEvent(event: ConfigEvent): string {
  return `${event.name}（${eventKeyOf(event)}）`;
}
