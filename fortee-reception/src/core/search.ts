import type { PublishedConfig } from "./config.ts";
import { compareCodeUnits, type SnapshotIndex } from "./snapshot.ts";

// 検索（Design Doc 5.5、FR-24、画面設計書 S05）。
//
// ライブラリを使わず、正規化した文字列の部分一致で行う。正規化は検索にだけ使い、
// ユーザの同一性の判定と、記録に写す値には使わない（PRD 7.1）。

/** 候補の件数の上限（画面設計書 S05） */
export const SEARCH_LIMIT = 20;

const KATAKANA = /[ァ-ヶヽヾ]/g;
const IGNORED = /[\s\-_ー・.]/g;

/**
 * 検索のための正規化（Design Doc 5.5）。NFKC 正規化、小文字化、カタカナをひらがなに変換、
 * 空白と `-`、`_`、`ー`、`・`、`.` の除去を行う。検索語と検索対象の列の両方に同じ規則を使う
 */
export function normalizeSearchText(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(KATAKANA, (char) => String.fromCharCode(char.charCodeAt(0) - 0x60))
    .replace(IGNORED, "");
}

export type SearchIndex = {
  /** ユーザごとの、正規化した検索対象の文字列。fortee ユーザ名の昇順（符号単位の順） */
  entries: { userName: string; keys: string[] }[];
};

/**
 * 検索の索引を作る（Design Doc 5.5）。スナップショットを読み込んだときに 1 回作り、入力のたびには作らない。
 *
 * ユーザの検索対象の文字列は、設定の search.columns と search.answers の列を、そのユーザのすべてのチケットに
 * ついて集めたもの。search.answers の列は、その項目のイベントのチケットからだけ集める。空の値は入れない
 */
export function buildSearchIndex(index: SnapshotIndex, config: Pick<PublishedConfig, "search">): SearchIndex {
  const { columns, answers } = config.search;
  const entries: SearchIndex["entries"] = [];
  for (const [userName, tickets] of index.byUser) {
    const keys = new Set<string>();
    const add = (value: string | undefined) => {
      if (value === undefined) return;
      const key = normalizeSearchText(value);
      if (key !== "") keys.add(key);
    };
    for (const ticket of tickets) {
      for (const column of columns) add(ticket[column]);
      for (const answer of answers) {
        if (answer.event === ticket.eventId) add(ticket.answers[answer.field]);
      }
    }
    entries.push({ userName, keys: [...keys] });
  }
  entries.sort((a, b) => compareCodeUnits(a.userName, b.userName));
  return { entries };
}

/** 一致の強さ。exact は完全一致、prefix は前方一致、partial はそれ以外の部分一致（正規化した文字列で比べる） */
export type SearchMatch = "exact" | "prefix" | "partial";

export type SearchHit = {
  /** 候補の fortee ユーザ名。チケットは索引の byUser から引く */
  userName: string;
  match: SearchMatch;
};

/**
 * 検索する（Design Doc 5.5）。候補はユーザ単位。
 *
 * 正規化した検索語が、検索対象の文字列のどれかに部分一致するユーザを返す。検索語が空（正規化して空になるものを含む）なら
 * 候補を出さない。どれかの文字列に完全一致した候補、前方一致した候補、それ以外の順に並べ、
 * 同じ順位の中は fortee ユーザ名の昇順にして、limit 件で切る
 */
export function search(searchIndex: SearchIndex, query: string, limit: number = SEARCH_LIMIT): SearchHit[] {
  const needle = normalizeSearchText(query);
  if (needle === "") return [];

  const exact: SearchHit[] = [];
  const prefix: SearchHit[] = [];
  const partial: SearchHit[] = [];
  for (const { userName, keys } of searchIndex.entries) {
    // ユーザの順位は、すべての文字列のうち、最も強い一致で決める
    let best: SearchMatch | null = null;
    for (const key of keys) {
      const at = key.indexOf(needle);
      if (at < 0) continue;
      if (key.length === needle.length) {
        best = "exact";
        break;
      }
      if (at === 0) best = "prefix";
      else if (best === null) best = "partial";
    }
    if (best === "exact") exact.push({ userName, match: best });
    else if (best === "prefix") prefix.push({ userName, match: best });
    else if (best === "partial") partial.push({ userName, match: best });
  }
  return [...exact, ...prefix, ...partial].slice(0, limit);
}
