import * as z from "zod/mini";
import {
  answerKeyOf,
  conferenceSchema,
  type PublishedConfig,
  publishedConfigSchema,
  resolveEventRef,
  SEARCH_COLUMNS,
  type SearchColumn,
} from "./config.ts";
import { EVENT_ID_PATTERN, identifierSchema } from "./fields.ts";
import { validateTemplate } from "./template.ts";
import { checkLocalDateTime, isValidTimezone, localDateTimeToEpochMs } from "./time.ts";
import { DISTRIBUTION_FORMAT } from "./versions.ts";

// 設定ファイル全体の形、設定検証（Design Doc 4.2 の検証の表、FR-4）、公開する JSON への変換。
//
// 使うのは管理 CLI（validate、publish、preview）だけで、受付アプリはこのモジュールを読まない。
// TOML を読むのは CLI であり、ここは TOML を解析した後の値を受け取る。smol-toml には依存しない。
// 期間のローカル日時は、CLI がオフセットのない文字列（`2026-11-27T17:30:00`。smol-toml の
// TomlDate#toISOString() が返す形）に直してから渡す。

const refs = z.array(z.string());

const fileAnswerSchema = z.strictObject({
  event: z.string(),
  field: z.string(),
  key: z.optional(z.string()),
});

/**
 * 設定ファイル（TOML を解析した値）の形。ここで確かめるのは、項目の有無と型だけである。
 * 値の中身（識別子の形、参照、重複、期間など）は、validateConfigFile が、見つかった誤りをすべて集めて確かめる。
 * 知らない項目は誤りにする。項目名の打ち間違いが、省略として黙って通らないようにするためである
 */
export const configFileSchema = z.strictObject({
  conference: z.strictObject(conferenceSchema.def.shape),
  events: z.array(
    z.strictObject({
      id: z.string(),
      name: z.string(),
      key: z.optional(z.string()),
    }),
  ),
  receptions: z.optional(
    z.array(
      z.strictObject({
        id: z.string(),
        name: z.string(),
        /** 期間。ローカル日時の文字列の組 */
        periods: z.array(z.strictObject({ start: z.string(), end: z.string() })),
        accept: refs,
        require: refs,
        checkin: refs,
        rejectMessage: z.string(),
      }),
    ),
  ),
  search: z.optional(
    z.strictObject({
      columns: z.optional(z.array(z.string())),
      answers: z.optional(z.array(fileAnswerSchema)),
    }),
  ),
  display: z.optional(
    z.strictObject({
      answers: z.optional(z.array(fileAnswerSchema)),
      ticketTypes: z.optional(
        z.array(
          z.strictObject({
            event: z.string(),
            types: z.array(z.string()),
            key: z.string(),
          }),
        ),
      ),
    }),
  ),
  template: z.strictObject({ reference: z.string() }),
});
export type ConfigFile = z.infer<typeof configFileSchema>;

/** 設定検証の誤り。path は設定ファイルの中の場所（`receptions[1].periods[0].start` など） */
export type ConfigError = { path: string; message: string };

/** 公開する設定のうち、公開のときに決まる値（形式の版と公開の版）を除いたもの。参照と期間は解決済み */
export type ConfigBody = Omit<PublishedConfig, "format" | "version">;

export type ConfigValidation = { ok: true; config: ConfigBody } | { ok: false; errors: ConfigError[] };

export type ValidateConfigOptions = {
  /** CLI の --env。渡すと、conference.environment と一致することを確かめる（Design Doc 3.6） */
  env?: string;
};

const formatPath = (path: readonly PropertyKey[]): string =>
  path.reduce<string>(
    (text, part) => (typeof part === "number" ? `${text}[${part}]` : text === "" ? String(part) : `${text}.${String(part)}`),
    "",
  );

/** 値 → その値を持つ要素の番号（2 つ以上あるものだけ） */
function duplicates(values: readonly (string | undefined)[]): Map<string, number[]> {
  const positions = new Map<string, number[]>();
  values.forEach((value, i) => {
    if (value === undefined) return;
    const list = positions.get(value);
    if (list === undefined) positions.set(value, [i]);
    else list.push(i);
  });
  for (const [value, list] of positions) {
    if (list.length < 2) positions.delete(value);
  }
  return positions;
}

const PERIOD_MESSAGES = {
  format: "ローカル日時（オフセットのない YYYY-MM-DDTHH:mm:ss）で書きます",
  invalidDate: "暦にない日時です",
  nonexistent: "夏時間の切り替えで、このタイムゾーンに存在しない時刻です",
  ambiguous: "夏時間の切り替えで、このタイムゾーンに 2 回ある時刻です。別の時刻にしてください",
} as const;

/**
 * 設定検証（FR-4、Design Doc 4.2 の検証の表）。TOML を解析した値を受け取り、誤りをすべて列挙して返す。
 * 通れば、参照を id に解決し、期間をエポックミリ秒にし、省略された項目を埋めた値を返す。
 *
 * 検証は 2 段で行う。項目の有無と型の誤り（configFileSchema）があれば、それだけを返す。
 * 型が合っていれば、表の各項目を互いに独立に確かめ、ほかの項目に誤りがあっても続ける。
 * 型の誤りの文言は zod のもので、日本語にするには、入口で configureJapaneseMessages を呼んでおく
 */
export function validateConfigFile(raw: unknown, options: ValidateConfigOptions = {}): ConfigValidation {
  const parsed = configFileSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((issue) => ({ path: formatPath(issue.path), message: issue.message })),
    };
  }
  const file = parsed.data;
  const errors: ConfigError[] = [];
  const error = (path: string, message: string) => errors.push({ path, message });

  const { conference, events } = file;
  const receptions = file.receptions ?? [];
  const searchColumns = file.search?.columns ?? [...SEARCH_COLUMNS];
  const searchAnswers = file.search?.answers ?? [];
  const displayAnswers = file.display?.answers ?? [];
  const ticketTypes = file.display?.ticketTypes ?? [];

  // conference.environment が、CLI の --env と一致する
  if (options.env !== undefined && conference.environment !== options.env) {
    error("conference.environment", `"${conference.environment}" が --env（"${options.env}"）と一致しません`);
  }

  // timezone が IANA のタイムゾーン名として解釈できる
  const timezoneValid = isValidTimezone(conference.timezone);
  if (!timezoneValid) {
    error("conference.timezone", `"${conference.timezone}" は IANA のタイムゾーン名として解釈できません`);
  }

  // イベントの id と key の形
  events.forEach((event, i) => {
    if (!EVENT_ID_PATTERN.test(event.id)) {
      error(`events[${i}].id`, `"${event.id}" は使えません。英数字、-、_ の 1〜64 文字にします`);
    }
    if (event.key !== undefined && !identifierSchema.safeParse(event.key).success) {
      error(`events[${i}].key`, `"${event.key}" は使えません。英数字、-、_ の 1〜32 文字にします`);
    }
  });

  // イベントの id と key が重複しない
  for (const [id, positions] of duplicates(events.map((event) => event.id))) {
    for (const i of positions.slice(1)) error(`events[${i}].id`, `"${id}" が events[${positions[0]}].id と重複しています`);
  }
  for (const [key, positions] of duplicates(events.map((event) => event.key))) {
    for (const i of positions.slice(1)) error(`events[${i}].key`, `"${key}" が events[${positions[0]}].key と重複しています`);
  }
  // key がほかのイベントの id と同じだと、イベントの参照がどちらを指すか決まらない
  events.forEach((event, i) => {
    if (event.key === undefined) return;
    const other = events.findIndex((candidate, j) => j !== i && candidate.id === event.key);
    if (other >= 0) error(`events[${i}].key`, `"${event.key}" が events[${other}].id と同じです`);
  });

  // 受付の id の形と重複
  receptions.forEach((reception, i) => {
    if (!identifierSchema.safeParse(reception.id).success) {
      error(`receptions[${i}].id`, `"${reception.id}" は使えません。英数字、-、_ の 1〜32 文字にします`);
    }
  });
  for (const [id, positions] of duplicates(receptions.map((reception) => reception.id))) {
    for (const i of positions.slice(1)) {
      error(`receptions[${i}].id`, `"${id}" が receptions[${positions[0]}].id と重複しています`);
    }
  }

  // イベントの参照が、events の key か id を指す。指さない参照は null にして、後の検証から外す
  const resolve = (path: string, ref: string): string | null => {
    const id = resolveEventRef(events, ref);
    if (id === null) error(path, `"${ref}" は events の key でも id でもありません`);
    return id;
  };
  // 同じイベントを 2 回指す参照（key と id で書いた場合を含む）は誤りにする。
  // 解決した後の一覧に同じイベントが並ぶと、判定の「残るイベント」や案内に同じイベントが 2 回出る
  const resolveAll = (path: string, list: readonly string[]) => {
    const seen = new Set<string>();
    return list.map((ref, i) => {
      const id = resolve(`${path}[${i}]`, ref);
      if (id !== null) {
        if (seen.has(id)) error(`${path}[${i}]`, `"${ref}" は、同じ一覧の中で同じイベントを 2 回指しています`);
        seen.add(id);
      }
      return id;
    });
  };

  // search.columns の値
  searchColumns.forEach((column, i) => {
    if (!(SEARCH_COLUMNS as readonly string[]).includes(column)) {
      error(`search.columns[${i}]`, `"${column}" は使えません。${SEARCH_COLUMNS.join("、")} のいずれかにします`);
    }
  });

  // 受付: 参照、checkin ⊆ accept、期間
  type ParsedPeriod = { path: string; receptionIndex: number; start: number; end: number };
  const allPeriods: ParsedPeriod[] = [];
  const resolvedReceptions = receptions.map((reception, i) => {
    const path = `receptions[${i}]`;
    const accept = resolveAll(`${path}.accept`, reception.accept);
    const require = resolveAll(`${path}.require`, reception.require);
    const checkin = resolveAll(`${path}.checkin`, reception.checkin);
    checkin.forEach((id, j) => {
      if (id !== null && !accept.includes(id)) {
        error(`${path}.checkin[${j}]`, `"${reception.checkin[j]}" が accept に含まれていません。チェックインするイベントは、受け付けるイベントに含めます`);
      }
    });

    // 受付は 1 つ以上の期間を持つ（FR-2）
    if (reception.periods.length === 0) error(`${path}.periods`, "期間を 1 つ以上書きます");

    const periods = reception.periods.map((period, j) => {
      const periodPath = `${path}.periods[${j}]`;
      const toEpochMs = (side: "start" | "end"): number | null => {
        const local = period[side];
        const shape = checkLocalDateTime(local);
        if (shape !== "ok") {
          error(`${periodPath}.${side}`, `"${local}": ${PERIOD_MESSAGES[shape]}`);
          return null;
        }
        // タイムゾーンが解釈できなければ、形だけを見る
        if (!timezoneValid) return null;
        const result = localDateTimeToEpochMs(local, conference.timezone);
        if (!result.ok) {
          error(`${periodPath}.${side}`, `"${local}": ${PERIOD_MESSAGES[result.reason]}`);
          return null;
        }
        return result.epochMs;
      };
      const start = toEpochMs("start");
      const end = toEpochMs("end");
      if (start === null || end === null) return null;
      if (start >= end) {
        error(periodPath, `start（${period.start}）が end（${period.end}）より前ではありません`);
        return null;
      }
      allPeriods.push({ path: periodPath, receptionIndex: i, start, end });
      return { start, end };
    });

    return { id: reception.id, name: reception.name, periods, accept, require, checkin, rejectMessage: reception.rejectMessage };
  });

  // すべての受付のすべての期間が、互いに重複しない。開始を含み、終了を含まないので、終了と開始が同じ時刻でも重複ではない
  allPeriods.forEach((later, j) => {
    for (const earlier of allPeriods.slice(0, j)) {
      if (earlier.start < later.end && later.start < earlier.end) {
        const owner = receptions[earlier.receptionIndex]?.id ?? "";
        error(later.path, `${earlier.path}（受付 "${owner}"）と重複しています`);
      }
    }
  });

  // アンケートの項目: 参照と、同じイベントの中での key（省略時は field）の重複。display と search は別々に見る
  const resolveAnswers = (path: string, answers: readonly { event: string; field: string; key?: string | undefined }[]) => {
    const resolved = answers.map((answer, i) => ({ ...answer, event: resolve(`${path}[${i}].event`, answer.event) }));
    // 同じイベントかどうかは、解決した id で見る。解決できない参照は、書かれた値のままで比べる
    const scoped = resolved.map((answer, i) => `${answer.event ?? `?${answers[i]?.event}`}\u0000${answerKeyOf(answer)}`);
    for (const positions of duplicates(scoped).values()) {
      for (const i of positions.slice(1)) {
        const answer = answers[i];
        if (answer === undefined) continue;
        const name = answer.key === undefined ? "field" : "key";
        error(`${path}[${i}].${name}`, `"${answerKeyOf(answer)}" が、同じイベントの ${path}[${positions[0]}] と重複しています`);
      }
    }
    return resolved;
  };
  const resolvedSearchAnswers = resolveAnswers("search.answers", searchAnswers);
  const resolvedDisplayAnswers = resolveAnswers("display.answers", displayAnswers);

  // display.ticketTypes: 参照、同じイベントの中での key の重複、types が空でなく重複しない
  const resolvedTicketTypes = ticketTypes.map((group, i) => {
    const path = `display.ticketTypes[${i}]`;
    if (group.types.length === 0) error(`${path}.types`, "種別を 1 つ以上書きます");
    for (const [type, positions] of duplicates(group.types)) {
      for (const j of positions.slice(1)) error(`${path}.types[${j}]`, `"${type}" が ${path}.types[${positions[0]}] と重複しています`);
    }
    return { ...group, event: resolve(`${path}.event`, group.event) };
  });
  const scopedTypeKeys = resolvedTicketTypes.map((group, i) => `${group.event ?? `?${ticketTypes[i]?.event}`}\u0000${group.key}`);
  for (const positions of duplicates(scopedTypeKeys).values()) {
    for (const i of positions.slice(1)) {
      error(`display.ticketTypes[${i}].key`, `"${ticketTypes[i]?.key}" が、同じイベントの display.ticketTypes[${positions[0]}] と重複しています`);
    }
  }

  // テンプレートから参照する名前に、「.」と空白を含めない
  const NAME_SEPARATORS = /[.\s]/;
  displayAnswers.forEach((answer, i) => {
    if (NAME_SEPARATORS.test(answerKeyOf(answer))) {
      error(
        `display.answers[${i}].${answer.key === undefined ? "field" : "key"}`,
        answer.key === undefined
          ? `項目名 "${answer.field}" は「.」か空白を含むので、テンプレートから参照できません。「.」と空白を含まない key を付けます`
          : `"${answer.key}" は使えません。key に「.」と空白は使えません`,
      );
    }
  });
  ticketTypes.forEach((group, i) => {
    if (NAME_SEPARATORS.test(group.key)) {
      error(`display.ticketTypes[${i}].key`, `"${group.key}" は使えません。key に「.」と空白は使えません`);
    }
  });

  // template.reference が解析でき、部分集合の検証と名前の検証を通る
  const templateErrors = validateTemplate(file.template.reference, {
    events,
    receptions,
    display: { answers: displayAnswers, ticketTypes },
  });
  for (const templateError of templateErrors) {
    const where = templateError.position === undefined ? "" : `${lineOf(file.template.reference, templateError.position)} 行目: `;
    error("template.reference", `${where}${templateError.message}`);
  }

  if (errors.length > 0) return { ok: false, errors };

  // ここからは誤りがないので、解決できなかった値（null）は残っていない
  const present = <T>(values: readonly (T | null)[]): T[] => values.filter((value): value is T => value !== null);
  const config: ConfigBody = {
    conference,
    events: events.map((event) => (event.key === undefined ? { id: event.id, name: event.name } : { id: event.id, name: event.name, key: event.key })),
    receptions: resolvedReceptions.map((reception) => ({
      ...reception,
      periods: present(reception.periods),
      accept: present(reception.accept),
      require: present(reception.require),
      checkin: present(reception.checkin),
    })),
    search: {
      columns: searchColumns as SearchColumn[],
      answers: resolvedSearchAnswers.map((answer) => ({ ...answer, event: answer.event ?? "" })),
    },
    display: {
      answers: resolvedDisplayAnswers.map((answer) => ({ ...answer, event: answer.event ?? "" })),
      ticketTypes: resolvedTicketTypes.map((group) => ({ ...group, event: group.event ?? "" })),
    },
    template: { reference: file.template.reference },
  };

  // 公開する設定のスキーマにも通す。上の検証の漏れで、受付アプリが読めない設定を公開しないための確認である
  const published = publishedConfigSchema.safeParse(toPublishedConfig(config, 0));
  if (!published.success) {
    return {
      ok: false,
      errors: published.error.issues.map((issue) => ({ path: formatPath(issue.path), message: issue.message })),
    };
  }
  return { ok: true, config };
}

/** テンプレートの中の位置が、何行目か（1 から数える） */
function lineOf(text: string, position: number): number {
  let line = 1;
  for (let i = 0; i < position && i < text.length; i++) {
    if (text[i] === "\n") line++;
  }
  return line;
}

/**
 * 検証済みの設定から、公開する設定を作る（Design Doc 4.2）。
 * version は公開の版（公開した時刻のエポックミリ秒）で、呼び出し側が渡す。形式の版を加える
 */
export function toPublishedConfig(config: ConfigBody, version: number): PublishedConfig {
  return { format: DISTRIBUTION_FORMAT, version, ...config };
}
