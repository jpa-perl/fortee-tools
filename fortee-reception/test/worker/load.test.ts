import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CheckinRecord, ServerRecord } from "../../src/core/record.ts";
import type { SyncCursor } from "../../src/core/sync.ts";
import { syncResponseSchema } from "../../src/core/sync.ts";
import { cancel, checkin, postSync, resetDb, syncBody, ticketToken, validSession } from "./helpers.ts";

// 20 台相当の同期の試験（バックエンド 8.1、NFR-4）の簡易版。ローカルの D1 の上で、
// 同じ記録の再送、保存の後に応答を捨てる、別の端末での同じチケットの記録、ページングの途中の書き込み、
// 全台のオフラインからの一斉復帰を混ぜ、全端末とサーバの記録 ID の集合が一致することを確かめる。
// CPU 時間と D1 の行数は、ローカルでは確かめられない（デプロイした環境で確かめる）

beforeEach(async () => {
  await resetDb();
  // 要求ごとのログ（Design Doc 7.6）は、この試験では数千行になるので出さない
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

/** 再現できる乱数（mulberry32） */
function prng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DEVICES = 20;
const SEND_MAX = 50;

/** 受付アプリの同期（Design Doc 6.6、4.5）のうち、サーバとのやり取りに関わる部分だけを写した端末 */
class Device {
  readonly id: string;
  /** 端末にある記録。自分で作ったものと、受け取ったもの */
  readonly records = new Map<string, CheckinRecord>();
  /** サーバが付けた連番と受信時刻。再送で変わらないことを確かめる */
  readonly server = new Map<string, { seq: number; receivedAt: number }>();
  readonly unsent: CheckinRecord[] = [];
  cursor: SyncCursor | null = null;
  requests = 0;

  private readonly session: string;
  private readonly random: () => number;
  private readonly limit: number;

  constructor(index: number, session: string, random: () => number, limit: number) {
    this.id = `${index.toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`;
    this.session = session;
    this.random = random;
    this.limit = limit;
  }

  create(record: CheckinRecord): void {
    this.records.set(record.recordId, record);
    this.unsent.push(record);
  }

  /** 1 回の要求。fault は、応答を受けた後の端末の振る舞い */
  async request(fault: "none" | "drop-response"): Promise<{ hasMore: boolean }> {
    const sending = this.unsent.slice(0, SEND_MAX);
    const res = await postSync(
      syncBody({ deviceId: this.id, cursor: this.cursor, limit: this.limit, records: sending }),
      { session: this.session },
    );
    this.requests += 1;
    expect(res.status).toBe(200);
    const body = syncResponseSchema.parse(await res.json());
    // 保存の後に応答が失われた。端末は何も変えず、次に同じ記録を同じ受信位置で送り直す
    if (fault === "drop-response") return { hasMore: true };

    this.unsent.splice(0, sending.length);
    for (const record of body.records) this.receive(record);
    this.cursor = { generation: body.generation, seq: body.nextSeq };
    return { hasMore: body.hasMore };
  }

  private receive(record: ServerRecord): void {
    const { seq, receivedAt, ...rest } = record;
    const known = this.server.get(record.recordId);
    if (known !== undefined) expect({ seq, receivedAt }).toEqual(known);
    this.server.set(record.recordId, { seq, receivedAt });
    const own = this.records.get(record.recordId);
    if (own !== undefined) expect(rest).toEqual(own);
    this.records.set(record.recordId, rest);
  }

  /** 未送信がなくなり、続きがなくなるまで要求を続ける。途中で障害を混ぜる */
  async syncAll(faultRate: number): Promise<void> {
    for (;;) {
      const roll = this.random();
      const fault = roll < faultRate ? "drop-response" : "none";
      // 同じ記録の再送: 送信済みの記録を、未送信の先頭に戻して送る
      if (roll > 1 - faultRate && this.records.size > 0) {
        const own = [...this.records.values()].filter((r) => r.deviceId === this.id);
        const again = own[Math.floor(this.random() * own.length)];
        if (again !== undefined && !this.unsent.includes(again)) this.unsent.unshift(again);
      }
      const { hasMore } = await this.request(fault);
      if (!hasMore && this.unsent.length === 0) return;
    }
  }
}

describe("20 台相当の同期（バックエンド 8.1、NFR-4）", () => {
  it("障害を混ぜても、全端末とサーバの記録 ID の集合が一致する", async () => {
    const random = prng(20261112);
    const session = await validSession();
    // 件数を小さくして、ページングの途中にほかの端末の書き込みが入るようにする
    const devices = Array.from({ length: DEVICES }, (_, i) => new Device(i + 1, session, prng(i + 1), 30 + 10 * (i % 5)));
    // 複数の端末が同じチケットをチェックインする
    const sharedTickets = Array.from({ length: 10 }, ticketToken);
    const created: CheckinRecord[] = [];

    const createSome = (device: Device, count: number) => {
      for (let i = 0; i < count; i++) {
        const shared = random() < 0.3;
        const token = shared ? sharedTickets[Math.floor(random() * sharedTickets.length)]! : ticketToken();
        const record = checkin({ deviceId: device.id, ticketToken: token });
        device.create(record);
        created.push(record);
        if (random() < 0.2) {
          const undo = cancel({
            deviceId: device.id,
            ticketToken: token,
            reasonKind: "other",
            reasonText: "取り消しの理由 ".repeat(1 + Math.floor(random() * 100)),
            targetRecordIds: [record.recordId],
          });
          device.create(undo);
          created.push(undo);
        }
      }
    };

    // 受付の間: 各端末が記録を作り、並行して同期する。障害を 2 割ずつ混ぜる
    for (let round = 0; round < 4; round++) {
      for (const device of devices) createSome(device, 1 + Math.floor(random() * 6));
      await Promise.all(devices.map((device) => device.syncAll(0.2)));
    }

    // 全台がオフラインで記録を溜めてから、一斉に復帰する。50 件を超えて溜めた端末は、要求が複数になる
    for (const device of devices) createSome(device, 20 + Math.floor(random() * 50));
    await Promise.all(devices.map((device) => device.syncAll(0.2)));

    // 最後に、障害なしで全台が追いつく
    for (const device of devices) await device.syncAll(0);
    // 新しく準備した端末も、先頭からすべて受け取る
    const fresh = new Device(DEVICES + 1, session, prng(99), 200);
    await fresh.syncAll(0);

    const { results } = await env.DB.prepare("SELECT seq, record_id, received_at FROM records ORDER BY seq").all<{
      seq: number;
      record_id: string;
      received_at: number;
    }>();
    const serverIds = results.map((r) => r.record_id).sort();
    const createdIds = created.map((r) => r.recordId).sort();
    expect(new Set(createdIds).size).toBe(createdIds.length);
    expect(serverIds).toEqual(createdIds);
    expect(createdIds.length).toBeGreaterThan(DEVICES * 20);

    for (const device of [...devices, fresh]) {
      expect([...device.records.keys()].sort(), device.id).toEqual(serverIds);
      expect(device.unsent).toEqual([]);
      // 端末が見た連番と受信時刻は、サーバのいまの値と同じ（再送で変わっていない）
      for (const row of results) {
        expect(device.server.get(row.record_id)).toEqual({ seq: row.seq, receivedAt: row.received_at });
      }
    }
    // 連番に抜けがなく、受信時刻は連番の順に下がらない
    expect(results.map((r) => r.seq)).toEqual(results.map((_, i) => i + 1));
    for (let i = 1; i < results.length; i++) {
      expect(results[i]!.received_at).toBeGreaterThanOrEqual(results[i - 1]!.received_at);
    }
  }, 60_000);
});
