import { env, exports } from "cloudflare:workers";
import type { CheckinRecord } from "../../src/core/record.ts";
import type { SyncRequest, SyncResponse } from "../../src/core/sync.ts";
import { syncResponseSchema } from "../../src/core/sync.ts";
import { SYNC_PROTOCOL_VERSION } from "../../src/core/versions.ts";
import { issueSession, SESSION_COOKIE } from "../../src/worker/session.ts";

// worker のテストで共有する道具。Worker は、テストと同じ実行環境（workerd）の中で呼ぶ

export const ORIGIN = "https://checkin.test";
export const operator = { sub: "123456789012345678", name: "受付 太郎" };

export function request(path: string, init: RequestInit & { session?: string } = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (init.session !== undefined) headers.set("Cookie", `${SESSION_COOKIE}=${init.session}`);
  // リダイレクトの応答は、辿らずにそのまま受け取る。辿ると、認可の開始の応答で Discord に通信してしまう
  return exports.default.fetch(new Request(`${ORIGIN}${path}`, { redirect: "manual", ...init, headers }));
}

export const validSession = () => issueSession(env.SESSION_SECRET, operator, Date.now());

/**
 * ローカルの D1 は、同じファイルのテストのあいだで共有される。記録、端末、版を消して、世代だけを残す。
 * 消した後の連番は 1 から付き直す（AUTOINCREMENT を付けていないため）
 */
export async function resetDb(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM records"),
    env.DB.prepare("DELETE FROM devices"),
    env.DB.prepare("DELETE FROM meta WHERE key = 'versions'"),
  ]);
}

export async function currentGeneration(): Promise<string> {
  const row = await env.DB.prepare("SELECT value FROM meta WHERE key = 'generation'").first<{ value: string }>();
  if (row === null) throw new Error("世代がない");
  return row.value;
}

export const DEVICE_A = "aaaaaaaa-0000-4000-8000-000000000001";
export const DEVICE_B = "bbbbbbbb-0000-4000-8000-000000000002";

let ticketCounter = 0;
/** 英数字 32 文字のチケットトークン */
export function ticketToken(): string {
  ticketCounter += 1;
  return `T${String(ticketCounter).padStart(31, "0")}`;
}

type CheckinOf = Extract<CheckinRecord, { op: "checkin" }>;
type CancelOf = Extract<CheckinRecord, { op: "cancel" }>;

export function checkin(overrides: Partial<CheckinOf> = {}): CheckinOf {
  return {
    recordId: crypto.randomUUID(),
    opId: crypto.randomUUID(),
    op: "checkin",
    ticketToken: ticketToken(),
    userName: "karupanerura",
    ticketNo: "A-12",
    reception: "main",
    route: "qr",
    reasonKind: null,
    reasonText: null,
    targetRecordIds: null,
    deviceTime: Date.now(),
    deviceId: DEVICE_A,
    operatorId: operator.sub,
    operatorName: operator.name,
    ...overrides,
  };
}

export function cancel(overrides: Partial<CancelOf> = {}): CancelOf {
  return {
    recordId: crypto.randomUUID(),
    opId: crypto.randomUUID(),
    op: "cancel",
    ticketToken: ticketToken(),
    userName: "karupanerura",
    ticketNo: "A-12",
    reception: null,
    route: null,
    reasonKind: "mistake",
    reasonText: null,
    targetRecordIds: [crypto.randomUUID()],
    deviceTime: Date.now(),
    deviceId: DEVICE_A,
    operatorId: operator.sub,
    operatorName: operator.name,
    ...overrides,
  };
}

export function syncBody(overrides: Partial<SyncRequest> = {}): SyncRequest {
  return {
    v: SYNC_PROTOCOL_VERSION,
    deviceId: DEVICE_A,
    deviceTime: Date.now(),
    appVersion: "v0.0.0-test",
    cursor: null,
    records: [],
    ...overrides,
  };
}

/** 同期の要求を、ブラウザの受付アプリと同じ形（同じオリジン、JSON）で送る */
export async function postSync(body: unknown, init: { session?: string; headers?: Record<string, string> } = {}) {
  return request("/api/sync", {
    method: "POST",
    session: init.session ?? (await validSession()),
    headers: { "Content-Type": "application/json", "Sec-Fetch-Site": "same-origin", ...init.headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

/** 同期して、200 の応答を、受付アプリと同じ core のスキーマで検証して返す */
export async function sync(overrides: Partial<SyncRequest> = {}): Promise<SyncResponse> {
  const res = await postSync(syncBody(overrides));
  if (res.status !== 200) throw new Error(`同期が ${res.status} を返した`);
  return syncResponseSchema.parse(await res.json());
}

/** 記録 1 件の JSON の UTF-8 のバイト数（Design Doc 7.3 の受信の上限の数え方） */
export function recordBytes(record: unknown): number {
  return new TextEncoder().encode(JSON.stringify(record)).byteLength;
}

export async function countRecords(): Promise<number> {
  const row = await env.DB.prepare("SELECT count(*) AS n FROM records").first<{ n: number }>();
  return row?.n ?? 0;
}
