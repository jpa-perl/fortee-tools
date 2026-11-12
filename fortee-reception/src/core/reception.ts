import type { PublishedConfig, Reception } from "./config.ts";

// 受付の選択と提案（Design Doc 5.2、FR-6〜9）。
//
// 期間は開始を含み、終了を含まない（start <= 時刻 < end。FR-3）。時刻はエポックミリ秒の数値で比べ、
// タイムゾーンの解釈を持たない（Design Doc 4.7）。現在時刻は呼び出し側が引数で渡す。

/** 受付の一覧を持つ設定。公開する設定をそのまま渡せる */
export type ReceptionsConfig = Pick<PublishedConfig, "receptions">;

const includes = (reception: Reception, time: number) =>
  reception.periods.some((period) => period.start <= time && time < period.end);

/**
 * 自動の選択（FR-6）。現在時刻を期間に含む受付を返す。なければ null（受付なし。FR-7）。
 * 期間は重複しない（FR-3）ので、高々 1 つである
 */
export function selectReception(config: ReceptionsConfig, now: number): Reception | null {
  return config.receptions.find((reception) => includes(reception, now)) ?? null;
}

/**
 * 次の境界。その時刻より後の、すべての受付のすべての期間の開始と終了のうち、最も早いもの。なければ null。
 * 手動の上書きの持続の終わり（FR-8）と、保留の判定（Design Doc 6.2）に使う
 */
export function nextBoundary(config: ReceptionsConfig, time: number): number | null {
  let next: number | null = null;
  for (const reception of config.receptions) {
    for (const period of reception.periods) {
      for (const boundary of [period.start, period.end]) {
        if (boundary > time && (next === null || boundary < next)) next = boundary;
      }
    }
  }
  return next;
}

/**
 * 受付の状態（画面設計書 S02-M1）。
 *
 * - inPeriod: 期間中（現在時刻がどれかの期間に含まれる）
 * - upcoming: これから（これから始まる期間がある）
 * - ended: 終了（どちらでもない。期間を 1 つも持たない受付を含む）
 */
export type ReceptionStatus = "inPeriod" | "upcoming" | "ended";

export function receptionStatus(reception: Reception, now: number): ReceptionStatus {
  if (includes(reception, now)) return "inPeriod";
  if (reception.periods.some((period) => period.start > now)) return "upcoming";
  return "ended";
}

export type SwitchSuggestion = {
  /** 提案する受付 */
  reception: Reception;
  /** 現在時刻が、その受付のどの期間にも含まれないか。真なら、期間外であることを警告する（FR-9） */
  outOfPeriod: boolean;
};

/**
 * 切り替えの提案（FR-9）。チケットのイベントを accept に含む、現在以外の受付から 1 つを選ぶ。なければ null。
 *
 * 終了していない候補（期間中か、これから始まる期間を持つ）があれば、現在時刻との隔たりが最も小さいものを選び、
 * 隔たりが同じならこれから始まるほうを選ぶ。終了していない候補がなければ、最も最近に終了したものを選ぶ。
 * それでも決まらなければ、設定の順で先のものを選ぶ。
 *
 * 隔たりは、その受付の期間のうち現在時刻に最も近いものまでの時間である（期間中なら 0、終わった期間なら
 * 終了からの時間、これからの期間なら開始までの時間）。終了していない候補は、終わった期間とこれからの期間の
 * 両方を持つことがある（日ごとの期間を持つ受付の、日のあいだ）。これからの期間だけで測ると、10 分前に
 * その日の期間を終えた受付より、2 時間後に始まる受付が先になり、FR-9 の「隔たりが同じなら、これから
 * 始まるほう」も起こりえない条件になる
 */
export function suggestSwitch(
  config: ReceptionsConfig,
  current: Reception | null,
  now: number,
  eventId: string,
): SwitchSuggestion | null {
  let best: Candidate | null = null;
  for (const reception of config.receptions) {
    if (current !== null && reception.id === current.id) continue;
    if (!reception.accept.includes(eventId)) continue;

    const status = receptionStatus(reception, now);
    // 最も近い期間までの時間と、その期間がこれから始まるものか
    let distance = Infinity; // 期間を持たない受付は、最も遠いものとして扱う
    let startsNext = false;
    for (const period of reception.periods) {
      const upcoming = period.start > now;
      const d = upcoming ? period.start - now : now < period.end ? 0 : now - period.end;
      if (d < distance || (d === distance && upcoming && !startsNext)) {
        distance = d;
        startsNext = upcoming;
      }
    }

    const candidate = { reception, ended: status === "ended", inPeriod: status === "inPeriod", distance, startsNext };
    if (best === null || isBetter(candidate, best)) best = candidate;
  }
  return best === null ? null : { reception: best.reception, outOfPeriod: !best.inPeriod };
}

type Candidate = { reception: Reception; ended: boolean; inPeriod: boolean; distance: number; startsNext: boolean };

/** 候補 a が、候補 b より先に選ばれるか。同じ順位なら false（設定の順で先のものを残す） */
function isBetter(a: Candidate, b: Candidate): boolean {
  if (a.ended !== b.ended) return b.ended;
  if (a.distance !== b.distance) return a.distance < b.distance;
  // 隔たりが同じなら、これから始まるほうを選ぶ（FR-9）
  return a.startsNext && !b.startsNext;
}

/**
 * 記録が持つ受付の識別子から、いまの設定の表示名を引く（画面設計書 2.9）。
 * 設定から消えた受付は、識別子をそのまま返す。受付なしのときに行った取り消し（null）は null を返す
 */
export function receptionDisplayName(config: ReceptionsConfig, receptionId: string | null): string | null {
  if (receptionId === null) return null;
  return config.receptions.find((reception) => reception.id === receptionId)?.name ?? receptionId;
}
