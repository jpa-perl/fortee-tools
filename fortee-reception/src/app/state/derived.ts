import { computed } from "@preact/signals";
import type { PublishedConfig, Reception } from "../../core/config.ts";
import { aggregate, compareRecords } from "../../core/records.ts";
import { selectReception } from "../../core/reception.ts";
import { buildSearchIndex } from "../../core/search.ts";
import { buildSnapshotIndex } from "../../core/snapshot.ts";
import { pickSyncStatus, type Versions } from "../../core/sync.ts";
import {
  config,
  type DeviceRecord,
  deviceId,
  judging,
  lastSyncFailed,
  needsLogin,
  now,
  online,
  type Overlay,
  overlay,
  override,
  type ReceptionOverride,
  records,
  type Screen,
  screen,
  snapshots,
  syncInFlight,
} from "./model.ts";

// 状態から導く値（Design Doc 6.2 の「導出」）。

/** 索引（Design Doc 5.1）。配布物がなければ null */
export const snapshotIndex = computed(() => {
  const current = config.value;
  if (current === null) return null;
  return buildSnapshotIndex(
    snapshots.value,
    current.events.map((event) => event.id),
  );
});

/** 検索の索引（Design Doc 5.5）。スナップショットを読み込んだときに 1 回作る */
export const searchIndex = computed(() => {
  const index = snapshotIndex.value;
  const current = config.value;
  return index === null || current === null ? null : buildSearchIndex(index, current);
});

/** チケットの状態（Design Doc 5.3）。端末にある全記録の集約 */
export const ticketStates = computed(() => aggregate(records.value));

/** 端末の版（Design Doc 6.7）。保存した設定とスナップショットから導き、別には保存しない */
export const deviceVersions = computed<Versions | null>(() => {
  const current = config.value;
  if (current === null) return null;
  return {
    config: current.version,
    events: Object.fromEntries(snapshots.value.map((snapshot) => [snapshot.eventId, snapshot.version])),
  };
});

/** 現在時刻での自動の受付（FR-6）。なければ null（受付なし） */
export const autoReception = computed<Reception | null>(() => {
  const current = config.value;
  return current === null ? null : selectReception(current, now.value);
});

/** 手動の上書きが、その時刻に有効なら、指す受付を返す。期限を過ぎたか、受付が設定になければ null */
export function overrideTarget(
  current: PublishedConfig | null,
  value: ReceptionOverride | null,
  time: number,
): Reception | null {
  if (current === null || value === null) return null;
  if (value.until !== null && time >= value.until) return null;
  return current.receptions.find((reception) => reception.id === value.receptionId) ?? null;
}

/**
 * いまの時刻と手動の上書きから求めた受付。受付操作の途中でも変わる。
 * 画面に出す受付は、これではなく、確定している受付（model.ts の confirmedReception）である
 */
export const effectiveReception = computed<{ reception: Reception | null; manual: boolean }>(() => {
  const target = overrideTarget(config.value, override.value, now.value);
  return target !== null ? { reception: target, manual: true } : { reception: autoReception.value, manual: false };
});

/**
 * 受付操作の途中か（Design Doc 6.2、画面設計書 2.7）。ホームの結果（見つからないを含む）、S06、S08 を
 * 表示している間と、シートかダイアログを表示している間、読み取りを受理してから結果を出すまで
 */
export function isMidOperation(current: Screen, sheet: Overlay, accepting: boolean): boolean {
  if (accepting || sheet !== null) return true;
  if (current.id === "S06" || current.id === "S08") return true;
  return current.id === "home" && (current.mode.kind === "result" || current.mode.kind === "notFound");
}

export const midOperation = computed(() => isMidOperation(screen.value, overlay.value, judging.value));

/** 未送信の記録があるか。件数は出さない（FR-31） */
export const hasUnsent = computed(() => records.value.some((record) => !record.sent));

/** ヘッダに出す同期の状態（画面設計書 2.3）。S09-D1 の警告も、この 1 つの状態で選ぶ */
export const syncStatus = computed(() =>
  pickSyncStatus({
    syncing: syncInFlight.value,
    offline: !online.value,
    needsLogin: needsLogin.value,
    failed: lastSyncFailed.value,
    hasUnsent: hasUnsent.value,
  }),
);

/** 1 回の操作（操作 ID が同じ記録）。履歴の 1 行（FR-39） */
export type Operation = {
  opId: string;
  op: "checkin" | "cancel";
  /** 端末の時刻 */
  deviceTime: number;
  /** 記録が持つ値（画面設計書 2.9） */
  userName: string;
  /** 対象のチケットの番号。記録の順。取り消しを複数の記録に分けたときも、チケットごとに 1 つ */
  ticketNos: string[];
  operatorName: string;
  deviceId: string;
  /** 未同期の記録を含むか */
  unsent: boolean;
  records: DeviceRecord[];
};

/** すべての端末の操作。新しい順（FR-28） */
export const operations = computed<Operation[]>(() => {
  const byOp = new Map<string, DeviceRecord[]>();
  for (const record of records.value) {
    const group = byOp.get(record.opId);
    if (group === undefined) byOp.set(record.opId, [record]);
    else group.push(record);
  }
  const result: Operation[] = [];
  for (const [opId, group] of byOp) {
    group.sort(compareRecords);
    const first = group[0] as DeviceRecord;
    result.push({
      opId,
      op: first.op,
      deviceTime: first.deviceTime,
      userName: first.userName,
      ticketNos: [...new Set(group.map((record) => record.ticketNo))],
      operatorName: first.operatorName,
      deviceId: first.deviceId,
      unsent: group.some((record) => !record.sent),
      records: group,
    });
  }
  return result.sort((a, b) => compareRecords(b.records[0] as DeviceRecord, a.records[0] as DeviceRecord));
});

/** この端末で行った操作。新しい順（S02 と S03 の直近の記録）。出す件数は画面が決める */
export const recentOperations = computed(() =>
  operations.value.filter((operation) => operation.deviceId === deviceId.value),
);
