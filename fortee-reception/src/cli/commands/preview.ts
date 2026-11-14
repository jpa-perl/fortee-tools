import type { ConfigBody } from "../../core/config-file.ts";
import { TICKET_TOKEN_PATTERN } from "../../core/fields.ts";
import { buildSnapshotIndex, type Snapshot, type Ticket } from "../../core/snapshot.ts";
import { buildTemplateContext, renderTemplate } from "../../core/template.ts";
import { CliError } from "../errors.ts";
import { describeEvent, eventOf } from "../references.ts";
import type { Target } from "../target.ts";
import { readSnapshot } from "../workdir.ts";

// preview（Design Doc 8.1、8.7、FR-46）。作業ディレクトリのスナップショットと設定から、参加者を 1 人指定して、
// 参考情報テンプレートを描画する。受付アプリの S04-M1 と同じ core の関数で文脈を作る（Design Doc 4.6）。
// D1 と KV には触れない。CLI の手元には記録がないので、チケットの状態は --done で指定する。
// 描画の結果は HTML で、受付アプリが表示するものと同じ文字列である（変数の値はエスケープ済み）。
// 参加者の情報を含む。標準出力にだけ出す。

export type PreviewOptions = {
  /** イベントの key か id */
  event: string;
  /** そのイベントの中のチケット番号。ticketToken とどちらか一方を指定する */
  ticket?: string | undefined;
  /**
   * チケットトークン（Ticket url の末尾の英数字 32 文字）。fortee の採番でチケット番号が重複した参加者は、
   * チケット番号では 1 人に決まらないので、こちらで指定する
   */
  ticketToken?: string | undefined;
  /** 現在の受付の id。省くと、受付なしの文脈で描画する */
  reception?: string | undefined;
  /** 済みにするチケット。「<イベントの key か id>:<チケット番号>」 */
  done?: readonly string[] | undefined;
};

export type PreviewDeps = {
  now: () => number;
  /** 描画の結果を出す */
  out: (text: string) => void;
  warn: (line: string) => void;
};

export async function preview(target: Target, config: ConfigBody, options: PreviewOptions, deps: PreviewDeps): Promise<void> {
  const event = eventOf(config, options.event, "--event");

  if ((options.ticket === undefined) === (options.ticketToken === undefined)) {
    throw new CliError("--ticket <チケット番号> か --ticket-token <チケットトークン> の、どちらか一方を指定してください");
  }
  if (options.ticketToken !== undefined && !TICKET_TOKEN_PATTERN.test(options.ticketToken)) {
    throw new CliError("--ticket-token は、英数字 32 文字で指定してください（CSV の Ticket url の末尾）");
  }

  const reception =
    options.reception === undefined ? null : (config.receptions.find((candidate) => candidate.id === options.reception) ?? undefined);
  if (reception === undefined) {
    const known = config.receptions.map((candidate) => candidate.id).join("、");
    throw new CliError(`--reception の "${options.reception}" は、設定の受付の id ではありません（設定にある受付: ${known}）`);
  }

  // 作業ディレクトリにある、設定のイベントのスナップショットをすべて読む。そのユーザのほかのイベントのチケットも文脈に入る
  const snapshots: Snapshot[] = [];
  for (const candidate of config.events) {
    const snapshot = await readSnapshot(target, candidate.id);
    if (snapshot !== null) {
      snapshots.push(snapshot);
    } else if (candidate.id === event.id) {
      throw new CliError(`${describeEvent(candidate)} のスナップショットが、作業ディレクトリにありません。先に import を実行してください`);
    } else {
      deps.warn(`警告: ${describeEvent(candidate)} のスナップショットが作業ディレクトリにないので、そのイベントのチケットを含めずに描画します`);
    }
  }
  const index = buildSnapshotIndex(snapshots, config.events.map((candidate) => candidate.id));
  const allTickets = [...index.byToken.values()];

  // チケット番号は、イベントを添えて引く。イベントの中でも、fortee の採番で重複することがある（Design Doc 8.3）ので、
  // 複数あれば、どれを描画するかを選ばずに止める。その参加者は、チケットトークンで指定する
  const find = (eventId: string, ticketNo: string): Ticket[] =>
    allTickets.filter((ticket) => ticket.eventId === eventId && ticket.ticketNo === ticketNo);

  let ticket: Ticket;
  if (options.ticketToken !== undefined) {
    // トークンは参加者の情報なので、誤りの文言に出さない
    const byToken = index.byToken.get(options.ticketToken);
    if (byToken === undefined || byToken.eventId !== event.id) {
      throw new CliError(`--ticket-token のチケットは、${describeEvent(event)} のスナップショットにありません`);
    }
    ticket = byToken;
  } else {
    const ticketNo = options.ticket ?? "";
    const found = find(event.id, ticketNo);
    const only = found[0];
    if (only === undefined || found.length !== 1) {
      throw new CliError(
        found.length === 0
          ? `--ticket の "${ticketNo}" は、${describeEvent(event)} のスナップショットにありません`
          : `--ticket の "${ticketNo}" が、${describeEvent(event)} のスナップショットに ${found.length} 枚あります。` +
            "--ticket-token <チケットトークン>（CSV の Ticket url の末尾の英数字 32 文字）で指定してください",
      );
    }
    ticket = only;
  }
  const tickets = index.byUser.get(ticket.userName) ?? [ticket];

  // --done で指定したチケットを済みにする。指定は「<イベント>:<チケット番号>」。イベントの key と id は「:」を含まない
  const doneTokens = new Set<string>();
  for (const spec of options.done ?? []) {
    const separator = spec.indexOf(":");
    if (separator <= 0 || separator === spec.length - 1) {
      throw new CliError(`--done の "${spec}" は、<イベントの key か id>:<チケット番号> の形で指定してください（例: --done main:A-12）`);
    }
    const doneEvent = eventOf(config, spec.slice(0, separator), "--done");
    const ticketNo = spec.slice(separator + 1);
    const doneTicket = tickets.find((candidate) => candidate.eventId === doneEvent.id && candidate.ticketNo === ticketNo);
    if (doneTicket === undefined) {
      throw new CliError(`--done の "${spec}" は、この参加者のチケットではありません。済みにできるのは、同じユーザのチケットだけです`);
    }
    doneTokens.add(doneTicket.ticketToken);
  }

  // 済みにしたチケットの doneAt は実行した時刻、doneReception は --reception の受付の表示名（指定がなければ空文字）
  const now = deps.now();
  const context = buildTemplateContext({
    userName: ticket.userName,
    tickets: tickets.map((candidate) => ({
      ticket: candidate,
      done: doneTokens.has(candidate.ticketToken) ? { at: now, receptionName: reception?.name ?? "" } : null,
    })),
    reception: reception === null ? null : { id: reception.id, name: reception.name },
    config,
    now,
  });

  const rendered = renderTemplate(config.template.reference, context);
  if (!rendered.ok) {
    throw new CliError(`テンプレートを描画できません\n${rendered.errors.map((error) => `  ${error.message}`).join("\n")}`);
  }
  deps.out(rendered.html);
}
