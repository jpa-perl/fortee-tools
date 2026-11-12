import type { PublishedConfig } from "../../core/config.ts";
import { nextBoundary, selectReception } from "../../core/reception.ts";
import type { CheckinRecord } from "../../core/record.ts";
import { compareRecords } from "../../core/records.ts";
import type { Snapshot } from "../../core/snapshot.ts";
import {
  SYNC_LIMIT_MAX,
  SYNC_RECORDS_MAX,
  SYNC_SEND_MAX_BYTES,
  type SyncCursor,
  type SyncRequest,
  type SyncResponse,
  type Versions,
} from "../../core/sync.ts";
import { SYNC_PROTOCOL_VERSION } from "../../core/versions.ts";
import { APP_RELEASE } from "../build-info.ts";
import { deviceVersions, hasUnsent, isMidOperation, overrideTarget } from "../state/derived.ts";
import {
  config,
  cursor,
  type DeviceRecord,
  deviceId,
  lastSyncAt,
  lastSyncFailed,
  needsLogin,
  type NoticeLine,
  now,
  online,
  overlay,
  override,
  records,
  screen,
  snapshots,
  syncInFlight,
} from "../state/model.ts";
import { replaceDistribution, resetGeneration, writeMeta, writeSyncResult } from "../storage/db.ts";
import { recomputeReception, showNotice } from "./reception.ts";
import { enqueue, rt } from "./runtime.ts";

// 同期（Design Doc 4.5、6.6）と、配布物の取得と差し替え（Design Doc 6.7）。
//
// 同期は同時に 1 つしか行わない。配布物の取得は、同期の中で、その同期の応答の versions について行うので、
// これも同時に 1 つになる。通信の結果は、反映の列（Design Doc 6.13）で 1 つずつ反映する。

/** 定期の同期の間隔（Design Doc 6.13 の調整値）。バックエンド 3 章の要求数の見積もりの前提 */
export const SYNC_INTERVAL_MS = 30_000;
/** 失敗の後の間隔の上限 */
export const SYNC_BACKOFF_MAX_MS = 10 * 60_000;
/** 1 回の同期で続けて送る要求の数の上限。サーバが受信位置を進めない誤りで、止まらなくなるのを防ぐ */
const MAX_REQUESTS_PER_SYNC = 1000;

/** 同期の終わり方 */
export type SyncOutcome =
  | "ok"
  /** 始めなかった（オフライン、同期中、起動していない） */
  | "skipped"
  /** 401。再ログインが必要 */
  | "unauthorized"
  /** 400。受付アプリと Worker の版の食い違いか、実装の誤り */
  | "rejected"
  /** そのほかの失敗（応答が届かない、失敗の応答、形の合わない応答、配布物の取得の失敗） */
  | "failed"
  /** ログアウトか再読み込みで中断した。失敗にしない */
  | "aborted";

// 起動の間だけ持つ値
let abort: AbortController | null = null;
/** 1 回の要求で送る記録の件数と、受け取る件数の上限。失敗の応答の後に半分にし、200 のたびに倍にして戻す（Design Doc 4.5） */
let sendMax = SYNC_RECORDS_MAX;
let receiveLimit = SYNC_LIMIT_MAX;
/** 続けて失敗した回数。間隔を延ばすのに使う */
let failures = 0;
/** 次の定期の同期の時刻 */
let nextSyncAt = 0;
/** 直前の同期の終わり方。失敗の後の再試行の条件に使う */
let lastOutcome: SyncOutcome = "ok";
/** 直近の応答の versions。配布物の差し替えの「いまの目標」 */
let targetVersions: Versions | null = null;
/** そろったが、受付操作の途中なので保留している配布物 */
let held: Distribution | null = null;
/** 列で順番を待っている、配布物の差し替えの数 */
let queuedSwaps = 0;

type Distribution = { versions: Versions; config: PublishedConfig; snapshots: Snapshot[] };

/** 起動のたびに、起動の間だけ持つ値を初期化する */
export function resetSync(): void {
  abort?.abort();
  abort = null;
  sendMax = SYNC_RECORDS_MAX;
  receiveLimit = SYNC_LIMIT_MAX;
  failures = 0;
  nextSyncAt = 0;
  lastOutcome = "ok";
  targetVersions = null;
  held = null;
}

/** 進行中の同期と配布物の取得を中断する（ログアウト、再読み込み、S99） */
export function abortSync(): void {
  abort?.abort();
}

/** 通信が進行中か。待機中の版を有効にする条件（Design Doc 6.11）に使う */
export function syncBusy(): boolean {
  return syncInFlight.value;
}

const sameVersions = (a: Versions | null, b: Versions | null): boolean => {
  if (a === null || b === null) return a === b;
  const ids = Object.keys(a.events);
  return (
    a.config === b.config &&
    ids.length === Object.keys(b.events).length &&
    ids.every((id) => a.events[id] === b.events[id])
  );
};

const sameCursor = (a: SyncCursor | null, b: SyncCursor | null): boolean =>
  a === null || b === null ? a === b : a.generation === b.generation && a.seq === b.seq;

const encoder = new TextEncoder();

/** 記録から、端末だけが持つ項目（sent、seq、receivedAt）を除く */
function toWire({ sent: _sent, seq: _seq, receivedAt: _receivedAt, ...record }: DeviceRecord): CheckinRecord {
  return record;
}

/**
 * 1 回の要求に載せる記録を選ぶ（Design Doc 6.6）。未送信のものを作った順に、max 件、かつ JSON の UTF-8 で
 * 200 KiB まで。1 件だけで超える記録も、飛ばさずに 1 件は載せる
 */
export function pickBatch(all: readonly DeviceRecord[], max: number): CheckinRecord[] {
  const unsent = all.filter((record) => !record.sent).sort(compareRecords);
  const batch: CheckinRecord[] = [];
  let bytes = 0;
  for (const record of unsent) {
    if (batch.length >= max) break;
    const wire = toWire(record);
    const size = encoder.encode(JSON.stringify(wire)).length + 1;
    if (batch.length > 0 && bytes + size > SYNC_SEND_MAX_BYTES) break;
    batch.push(wire);
    bytes += size;
  }
  return batch;
}

/** 失敗の後の間隔（Design Doc 6.6）。30 秒から倍々に延ばし、上限 10 分。端末ごとの乱数で散らす */
export function backoffDelay(failureCount: number, random: number): number {
  const base = Math.min(SYNC_BACKOFF_MAX_MS, SYNC_INTERVAL_MS * 2 ** Math.min(failureCount, 10));
  return Math.round(base * (0.75 + random * 0.5));
}

/** 受け取った記録を、メモリの記録に合流する */
function mergeRecords(changed: readonly DeviceRecord[]): void {
  if (changed.length === 0) return;
  const byId = new Map(records.value.map((record) => [record.recordId, record]));
  for (const record of changed) byId.set(record.recordId, record);
  records.value = [...byId.values()];
}

type ApplyResult = "applied" | "reset" | "stale";

/** 200 の応答を、反映の列で反映する（Design Doc 6.13 の表） */
function applyResponse(
  requestCursor: SyncCursor | null,
  sentRecordIds: string[],
  response: SyncResponse,
): Promise<ApplyResult | undefined> {
  return enqueue(async (db): Promise<ApplyResult> => {
    // 前提の照合。要求に使った受信位置が、いまも同じか
    if (!sameCursor(cursor.value, requestCursor)) return "stale";
    if (requestCursor !== null && requestCursor.generation !== response.generation) {
      // DB が戻された。初期化だけを行い、この応答の records と nextSeq、送った記録への sent は使わない
      const next = { generation: response.generation, seq: 0 };
      const all = await resetGeneration(db, next);
      records.value = all;
      cursor.value = next;
      return "reset";
    }
    const next = { generation: response.generation, seq: response.nextSeq };
    const changed = await writeSyncResult(db, { sentRecordIds, received: response.records, cursor: next });
    mergeRecords(changed);
    cursor.value = next;
    return "applied";
  });
}

/** 配布物の差し替え。列の処理の中で呼ぶ。知らせは 2 行に並べて同時に出す（画面設計書 2.7） */
async function swapDistribution(db: Parameters<typeof replaceDistribution>[0], bundle: Distribution): Promise<void> {
  const clearOverride = overrideTarget(bundle.config, override.value, rt.ports.platform.now()) === null;
  await replaceDistribution(db, bundle.config, bundle.snapshots, { clearOverride: clearOverride && override.value !== null });
  const first = config.value === null;
  config.value = bundle.config;
  snapshots.value = bundle.snapshots;
  if (clearOverride) override.value = null;
  now.value = rt.ports.platform.now();
  // 上書きが残るときは、持続の終わりを新しい設定の次の境界に付け直す（FR-8）。古い設定の境界のままだと、
  // 期間を変えた公開の後に、上書きが新しい境界を跨いでも続いたり、新しい境界の前に切れたりする
  const kept = override.value;
  if (kept !== null) {
    const next = { receptionId: kept.receptionId, until: nextBoundary(bundle.config, now.value) };
    if (next.until !== kept.until) {
      await writeMeta(db, "override", next);
      override.value = next;
    }
  }
  const line = recomputeReception();
  // 初回の取得（S01）は、差し替えではないので知らせない
  if (first) return;
  const lines: NoticeLine[] = line === null ? [] : [line];
  showNotice([...lines, { kind: "dataUpdated" }]);
}

/** そろった配布物を列に入れる。受付操作の途中なら保留する（Design Doc 6.13） */
function enqueueDistribution(bundle: Distribution): Promise<void | undefined> {
  queuedSwaps++;
  return enqueue(async (db) => {
    // 前提の照合。取得した版が、いまの目標と同じか。違えば、次の同期で取得し直す
    if (!sameVersions(bundle.versions, targetVersions)) return;
    // 読み取りの受理（judging）は見ない。受理した読み取りの判定は、この処理より前に列に入っていれば
    // 結果を出し終えており、後に入っていれば、差し替えた配布物で判定する（Design Doc 6.13）
    if (isMidOperation(screen.value, overlay.value, false)) {
      held = bundle;
      return;
    }
    held = null;
    await swapDistribution(db, bundle);
  }).finally(() => {
    queuedSwaps--;
  });
}

/**
 * 配布物の差し替えが、列で順番を待っているか。待っている間は、受付だけを先に計算し直さない。
 * 差し替えが受付も計算し直して、知らせを 2 行に並べて同時に出す（画面設計書 2.7）
 */
export function distributionQueued(): boolean {
  return queuedSwaps > 0;
}

/** 保留している配布物があれば、列に入れる。受付操作の途中が終わったときに呼ぶ。入れたら真 */
export function flushHeldDistribution(): boolean {
  if (held === null) return false;
  const bundle = held;
  held = null;
  void enqueueDistribution(bundle);
  return true;
}

/** 応答の versions が端末の版と違えば、違う分を取得して、差し替えを列に入れる（Design Doc 6.7） */
async function ensureDistribution(versions: Versions, signal: AbortSignal): Promise<SyncOutcome> {
  targetVersions = versions;
  if (sameVersions(versions, deviceVersions.value)) {
    // 保留している間に、端末の版が目標になった（公開の取り下げ）。保留を捨てる
    held = null;
    return "ok";
  }
  if (held !== null && sameVersions(versions, held.versions)) return "ok";
  // 保留している間にさらに新しい版を知ったら、保留したものを捨てて取得し直す
  held = null;

  const fail = (kind: "http" | "network" | "timeout" | "aborted" | "invalid", status?: number): SyncOutcome =>
    kind === "aborted" ? "aborted" : kind === "http" && status === 401 ? "unauthorized" : "failed";

  let nextConfig = config.value;
  if (nextConfig === null || nextConfig.version !== versions.config) {
    const result = await rt.ports.network.fetchConfig(versions.config, signal);
    if (result.kind !== "ok") return fail(result.kind, result.kind === "http" ? result.status : undefined);
    if (result.value.version !== versions.config) return "failed";
    nextConfig = result.value;
  }
  const current = new Map(snapshots.value.map((snapshot) => [snapshot.eventId, snapshot]));
  const nextSnapshots: Snapshot[] = [];
  // 応答の versions にないイベントは、差し替えのときに消える
  for (const [eventId, version] of Object.entries(versions.events)) {
    const existing = current.get(eventId);
    if (existing !== undefined && existing.version === version) {
      nextSnapshots.push(existing);
      continue;
    }
    const result = await rt.ports.network.fetchSnapshot(eventId, version, signal);
    if (result.kind !== "ok") return fail(result.kind, result.kind === "http" ? result.status : undefined);
    if (result.value.eventId !== eventId || result.value.version !== version) return "failed";
    nextSnapshots.push(result.value);
  }
  await enqueueDistribution({ versions, config: nextConfig, snapshots: nextSnapshots });
  return "ok";
}

/** 同期の要求を、応答の hasMore が真か、未送信の記録が残っている間、続けて送る */
async function exchange(signal: AbortSignal, epoch: number): Promise<SyncOutcome> {
  const device = deviceId.value;
  if (device === null) return "skipped";
  let versions: Versions | null | undefined;
  for (let i = 0; i < MAX_REQUESTS_PER_SYNC; i++) {
    const requestCursor = cursor.value;
    const batch = pickBatch(records.value, sendMax);
    const request: SyncRequest = {
      v: SYNC_PROTOCOL_VERSION,
      deviceId: device,
      deviceTime: rt.ports.platform.now(),
      appVersion: APP_RELEASE,
      cursor: requestCursor,
      limit: receiveLimit,
      records: batch,
    };
    const result = await rt.ports.network.sync(request, signal);
    // ログアウトの後に届いた応答は、反映しない
    if (epoch !== rt.loginEpoch || result.kind === "aborted") return "aborted";

    if (result.kind === "http" && result.status === 413 && batch.length > 1) {
      // 本文が大きすぎる。送る件数を半分にして送り直す。この間は失敗にしない
      sendMax = Math.max(1, Math.floor(batch.length / 2));
      continue;
    }
    if (result.kind === "http") {
      if (result.status === 401) return "unauthorized";
      if (result.status === 400) return "rejected";
      // 429 では減らさない。日次の上限は、量を減らしても直らない
      if (result.status !== 429 && result.status !== 413) {
        sendMax = Math.max(1, Math.floor(sendMax / 2));
        receiveLimit = Math.max(1, Math.floor(receiveLimit / 2));
      }
      return "failed";
    }
    if (result.kind !== "ok") return "failed";

    // 200 を受けるたびに倍にして、50 件と 200 件まで戻す
    sendMax = Math.min(SYNC_RECORDS_MAX, sendMax * 2);
    receiveLimit = Math.min(SYNC_LIMIT_MAX, receiveLimit * 2);
    needsLogin.value = false;

    const applied = await applyResponse(
      requestCursor,
      batch.map((record) => record.recordId),
      result.value,
    );
    if (applied === undefined) return "aborted";
    versions = result.value.versions;
    // 初期化の後は、hasMore によらず、新しい受信位置から要求を続ける
    if (applied === "reset" || applied === "stale") continue;
    if (!result.value.hasMore && !hasUnsent.value) break;
  }
  if (versions === undefined) return "failed";
  // まだ公開していない。取得するものがない（S01 の初回の取得では、呼び出し側が取得失敗にする）
  if (versions === null) return "ok";
  return ensureDistribution(versions, signal);
}

/**
 * 同期を 1 回行う。同期中か、オフラインなら始めない。終わり方を返す。
 * 失敗は同期の状態に反映し、画面を移らない（Design Doc 6.10）
 */
export async function runSync(): Promise<SyncOutcome> {
  if (rt.failed || rt.db === null || syncInFlight.value || !online.value) return "skipped";
  const epoch = rt.loginEpoch;
  const controller = new AbortController();
  abort = controller;
  syncInFlight.value = true;
  let outcome: SyncOutcome;
  try {
    outcome = await exchange(controller.signal, epoch);
  } catch (error) {
    console.error(error);
    outcome = "failed";
  }
  if (abort === controller) abort = null;
  // ログアウトの後は、同期の状態に触れない。ログアウトが初期化している
  if (epoch !== rt.loginEpoch) return "aborted";
  syncInFlight.value = false;
  if (outcome === "aborted" || outcome === "skipped") return outcome;

  const time = rt.ports.platform.now();
  lastOutcome = outcome;
  if (outcome === "ok") {
    // 同期と、その同期が必要にした配布物の取得の両方が成功した
    failures = 0;
    lastSyncFailed.value = false;
    nextSyncAt = time + SYNC_INTERVAL_MS;
    lastSyncAt.value = time;
    void enqueue((db) => writeMeta(db, "lastSyncAt", time));
  } else {
    failures++;
    lastSyncFailed.value = true;
    if (outcome === "unauthorized") needsLogin.value = true;
    nextSyncAt = time + backoffDelay(failures, rt.ports.platform.random());
  }
  rt.settle();
  return outcome;
}

/**
 * 定期の同期の条件（Design Doc 6.6）。画面が表示されていて、現在時刻がどれかの受付の期間に含まれるか、
 * 受付の手動の上書きが有効か、未送信の記録があるとき。直前の同期が 401 と 400 以外の失敗で終わっていれば、
 * 期間の外で未送信の記録がなくても再試行する
 */
function periodicSyncDue(time: number): boolean {
  if (!rt.ports.platform.visible() || time < nextSyncAt) return false;
  const settings = config.value;
  if (settings === null) return false;
  return (
    selectReception(settings, time) !== null ||
    overrideTarget(settings, override.value, time) !== null ||
    hasUnsent.value ||
    lastOutcome === "failed"
  );
}

/** 1 秒ごとに呼ぶ。条件を満たせば、定期の同期を始める */
export function syncTick(time: number): void {
  if (periodicSyncDue(time)) void runSync();
}

/** 次の定期の同期を、いまから 1 間隔の後にする（S01 の初回の取得で同期した直後） */
export function deferNextSync(): void {
  nextSyncAt = rt.ports.platform.now() + SYNC_INTERVAL_MS;
}
