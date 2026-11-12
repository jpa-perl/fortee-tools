import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { syncRequestSchema, SYNC_BODY_MAX_BYTES, SYNC_RECEIVE_MAX_BYTES } from "../../src/core/sync.ts";
import { SYNC_PROTOCOL_VERSION } from "../../src/core/versions.ts";
import { SESSION_COOKIE, signSession, verifySession } from "../../src/worker/session.ts";
import { DEVICE_MEASURE_INTERVAL_MS, runSync } from "../../src/worker/sync.ts";
import {
  cancel,
  checkin,
  countRecords,
  currentGeneration,
  DEVICE_A,
  DEVICE_B,
  operator,
  postSync,
  recordBytes,
  request,
  resetDb,
  sync,
  syncBody,
  validSession,
} from "./helpers.ts";

const DAY = 24 * 60 * 60 * 1000;

beforeEach(resetDb);

describe("同期: 記録の保存と受け取り（Design Doc 4.5、7.3）", () => {
  it("記録を保存し、連番と受信時刻を付けて返す", async () => {
    const before = Date.now();
    const records = [checkin(), checkin({ route: "search" })];
    const res = await sync({ records });

    expect(res.generation).toBe(await currentGeneration());
    expect(res.hasMore).toBe(false);
    expect(res.versions).toBeNull();
    expect(res.records.map((r) => r.seq)).toEqual([1, 2]);
    expect(res.nextSeq).toBe(2);
    for (const [i, record] of res.records.entries()) {
      const { seq: _seq, receivedAt, ...rest } = record;
      expect(rest).toEqual(records[i]);
      expect(receivedAt).toBeGreaterThanOrEqual(before);
      expect(receivedAt).toBeLessThanOrEqual(Date.now());
    }
  });

  it("再送は冪等で、保存済みの記録の連番と受信時刻を変えない", async () => {
    const records = [checkin(), checkin()];
    const first = await sync({ records });
    // 応答が失われた端末は、同じ記録を再送する。新しい記録が混ざっていてもよい
    const added = checkin();
    const second = await sync({ records: [...records, added] });

    expect(await countRecords()).toBe(3);
    expect(second.records.slice(0, 2)).toEqual(first.records);
    expect(second.records[2]?.recordId).toBe(added.recordId);

    // 同じ記録 ID で中身の違う記録を送っても、先に保存したものが残る
    await sync({ records: [{ ...records[0]!, userName: "書き換え" }] });
    const again = await sync();
    expect(again.records.slice(0, 2)).toEqual(first.records);
  });

  it("取り消しの targetRecordIds を保存し、同じ配列で返す", async () => {
    const target = checkin();
    const targetRecordIds = [target.recordId, crypto.randomUUID(), crypto.randomUUID()];
    const withReason = cancel({
      ticketToken: target.ticketToken,
      reception: "main",
      reasonKind: "other",
      reasonText: "引用符 ' \" と改行\n、; と \\ と絵文字 🎫 を含む",
      targetRecordIds,
    });
    const withoutReception = cancel({ ticketToken: target.ticketToken, targetRecordIds: [target.recordId] });
    const res = await sync({ records: [target, withReason, withoutReception] });

    const [c1, x1, x2] = res.records;
    expect(c1?.targetRecordIds).toBeNull();
    expect(x1?.targetRecordIds).toEqual(targetRecordIds);
    expect(x1?.reasonText).toBe(withReason.reasonText);
    expect(x2?.targetRecordIds).toEqual([target.recordId]);
    expect(x2?.reception).toBeNull();

    // D1 には、JSON の配列の文字列で入る。チェックインでは NULL
    const { results } = await env.DB.prepare("SELECT target_record_ids FROM records ORDER BY seq").all();
    expect(results.map((r) => r["target_record_ids"])).toEqual([
      null,
      JSON.stringify(targetRecordIds),
      JSON.stringify([target.recordId]),
    ]);
  });

  it("知らない項目を落として保存する", async () => {
    const record = { ...checkin(), unknownField: "x" };
    const res = await postSync({ ...syncBody({ records: [record] }), unknownTop: 1 });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { records: Record<string, unknown>[] };
    expect(body.records).toHaveLength(1);
    expect(body.records[0]).not.toHaveProperty("unknownField");
  });

  it("他端末の記録を、受信位置より後ろだけ受け取る", async () => {
    const a = await sync({ deviceId: DEVICE_A, records: [checkin(), checkin()] });
    const cursor = { generation: a.generation, seq: a.nextSeq };

    // 変化がなければ 0 件で、nextSeq は要求の seq のまま
    const idle = await sync({ cursor });
    expect(idle).toMatchObject({ records: [], nextSeq: cursor.seq, hasMore: false });

    const fromB = checkin({ deviceId: DEVICE_B });
    await sync({ deviceId: DEVICE_B, records: [fromB] });
    const next = await sync({ cursor });
    expect(next.records.map((r) => r.recordId)).toEqual([fromB.recordId]);
    expect(next.nextSeq).toBe(3);
  });
});

describe("同期: ページング（Design Doc 7.3）", () => {
  it("limit 件ずつ返し、hasMore と nextSeq で続きを取りこぼさない", async () => {
    const records = Array.from({ length: 12 }, () => checkin());
    const first = await sync({ records, limit: 5 });
    expect(first.records).toHaveLength(5);
    expect(first.hasMore).toBe(true);
    expect(first.nextSeq).toBe(5);

    const received = [...first.records];
    let cursor = { generation: first.generation, seq: first.nextSeq };
    let pages = 1;
    for (;;) {
      const page = await sync({ cursor, limit: 5 });
      received.push(...page.records);
      pages += 1;
      // nextSeq は、実際に返した最後の記録の連番
      expect(page.nextSeq).toBe(page.records.at(-1)?.seq);
      cursor = { generation: page.generation, seq: page.nextSeq };
      if (!page.hasMore) break;
    }
    expect(pages).toBe(3);
    expect(received.map((r) => r.recordId)).toEqual(records.map((r) => r.recordId));
  });

  it("ちょうど limit 件のときは、続きがないと答える", async () => {
    const res = await sync({ records: Array.from({ length: 5 }, () => checkin()), limit: 5 });
    expect(res.records).toHaveLength(5);
    expect(res.hasMore).toBe(false);
  });

  it("limit を省くと 200 件まで返す", async () => {
    for (let i = 0; i < 5; i++) await sync({ records: Array.from({ length: 50 }, () => checkin()), limit: 1 });
    const res = await sync();
    expect(res.records).toHaveLength(200);
    expect(res.hasMore).toBe(true);
    expect(res.nextSeq).toBe(200);
  });
});

describe("同期: 受信の上限（Design Doc 7.3）", () => {
  // 上限いっぱいの自由記述（2,000 文字）。UTF-8 で 6,000 バイト
  const longText = "あ".repeat(2000);
  const longCancel = () => cancel({ reasonKind: "other", reasonText: longText });

  it("長い自由記述の記録が並んでも、応答の記録が 128 KiB を超えず、続きを取りこぼさない", async () => {
    const records = Array.from({ length: 70 }, longCancel);
    // 送る側は 200 KiB で区切る（Design Doc 6.6）
    for (let i = 0; i < records.length; i += 25) await sync({ records: records.slice(i, i + 25), limit: 1 });

    const received: string[] = [];
    let cursor: { generation: string; seq: number } | null = null;
    let pages = 0;
    for (;;) {
      const page = await sync({ cursor });
      const bytes = page.records.reduce((sum, r) => sum + recordBytes(r), 0);
      expect(bytes).toBeLessThanOrEqual(SYNC_RECEIVE_MAX_BYTES);
      expect(page.records.length).toBeGreaterThan(0);
      // 件数の上限（200）には達していないので、ページを切ったのはバイト数である
      expect(page.records.length).toBeLessThan(70);
      received.push(...page.records.map((r) => r.recordId));
      pages += 1;
      cursor = { generation: page.generation, seq: page.nextSeq };
      if (!page.hasMore) break;
    }
    expect(pages).toBeGreaterThan(1);
    expect(received).toEqual(records.map((r) => r.recordId));
  });

  it("バイト数で切るページでも、limit の指定が効く", async () => {
    await sync({ records: Array.from({ length: 25 }, longCancel), limit: 1 });
    const res = await sync({ limit: 3 });
    expect(res.records).toHaveLength(3);
    expect(res.hasMore).toBe(true);
    expect(res.nextSeq).toBe(3);
  });

  it("文の中で数えるバイト数は、列名を鍵にした記録 1 件の JSON のバイト数と一致する", async () => {
    // 制御文字、引用符、バックスラッシュ、絵文字を含む値でも、数え方が合うこと
    const records = [
      checkin(),
      cancel({ reasonKind: "other", reasonText: "\u0001\n\"\\🎫あ".repeat(50), targetRecordIds: [crypto.randomUUID(), crypto.randomUUID()] }),
      longCancel(),
    ];
    const saved = await sync({ records });

    // D1 の行を、列名を鍵にした JSON（json_object で作るのと同じ形）にして数える
    const { results } = await env.DB.prepare("SELECT * FROM records ORDER BY seq").all();
    const rowBytes = results.map((row) =>
      recordBytes({ ...row, target_record_ids: row["target_record_ids"] === null ? null : JSON.parse(String(row["target_record_ids"])) }),
    );
    // 応答の記録（鍵が短い）は、この数え方を上回らない
    for (const [i, record] of saved.records.entries()) expect(recordBytes(record)).toBeLessThanOrEqual(rowBytes[i]!);

    const call = (receiveMaxBytes: number) =>
      runSync(env.DB, syncRequestSchema.parse(syncBody({ cursor: { generation: saved.generation, seq: 0 } })), {
        now: Date.now(),
        receiveMaxBytes,
      });
    const two = rowBytes[0]! + rowBytes[1]!;
    // 累積がちょうど上限なら入り、1 バイトでも超えれば入らない
    expect((await call(two)).records).toHaveLength(2);
    expect((await call(two - 1)).records).toHaveLength(1);
    expect((await call(two + rowBytes[2]!)).records).toHaveLength(3);
    expect((await call(two + rowBytes[2]! - 1)).records).toHaveLength(2);
    expect(await call(two - 1)).toMatchObject({ nextSeq: 1, hasMore: true });
  });

  it("1 件だけで上限を超える記録も 1 件は返し、同期が進む", async () => {
    const records = [longCancel(), longCancel(), checkin()];
    const saved = await sync({ records });
    const generation = saved.generation;
    const call = (seq: number) =>
      runSync(env.DB, syncRequestSchema.parse(syncBody({ cursor: { generation, seq } })), {
        now: Date.now(),
        // 上限を、長い記録 1 件より小さくする
        receiveMaxBytes: 1024,
      });

    const first = await call(0);
    expect(first.records.map((r) => r.recordId)).toEqual([records[0]!.recordId]);
    expect(first).toMatchObject({ nextSeq: 1, hasMore: true });
    const second = await call(first.nextSeq);
    expect(second.records.map((r) => r.recordId)).toEqual([records[1]!.recordId]);
    expect(second).toMatchObject({ nextSeq: 2, hasMore: true });
    const third = await call(second.nextSeq);
    expect(third.records.map((r) => r.recordId)).toEqual([records[2]!.recordId]);
    expect(third).toMatchObject({ nextSeq: 3, hasMore: false });
  });
});

describe("同期: 世代と版（Design Doc 4.5、7.3、9.5）", () => {
  it("世代の違う要求は、記録を保存するが、返さない", async () => {
    await sync({ records: [checkin(), checkin()] });
    const sent = checkin();
    const res = await sync({ cursor: { generation: "0".repeat(32), seq: 1 }, records: [sent] });

    expect(res).toMatchObject({ records: [], nextSeq: 0, hasMore: false });
    expect(res.generation).toBe(await currentGeneration());
    expect(await countRecords()).toBe(3);

    // 端末は、新しい世代の先頭から受け取り直す
    const again = await sync({ cursor: { generation: res.generation, seq: 0 }, records: [sent] });
    expect(again.records).toHaveLength(3);
    expect(await countRecords()).toBe(3);
  });

  it("世代が書き換わると、前の世代の受信位置には記録を返さない", async () => {
    const before = await sync({ records: [checkin()] });
    const original = before.generation;
    try {
      // 復旧（Design Doc 8.6）で CLI が行う書き換え
      await env.DB.prepare("UPDATE meta SET value = ?1 WHERE key = 'generation'").bind("f".repeat(32)).run();
      const res = await sync({ cursor: { generation: original, seq: 0 } });
      expect(res).toMatchObject({ generation: "f".repeat(32), records: [], nextSeq: 0, hasMore: false });
    } finally {
      await env.DB.prepare("UPDATE meta SET value = ?1 WHERE key = 'generation'").bind(original).run();
    }
  });

  it("公開した版を、meta.versions の値のまま返す", async () => {
    expect((await sync()).versions).toBeNull();

    const versions = { config: 1764100000000, events: { "8b2e79c9-0000-4000-8000-000000000000": 1764200000000 } };
    await env.DB.prepare("INSERT INTO meta (key, value) VALUES ('versions', ?1)").bind(JSON.stringify(versions)).run();
    expect((await sync()).versions).toEqual(versions);
    // 世代の違う要求にも、版は返す
    expect((await sync({ cursor: { generation: "x", seq: 0 } })).versions).toEqual(versions);
  });
});

describe("同期: 端末の時計の差とアプリのリリース（Design Doc 7.3、9.2）", () => {
  type DeviceRow = {
    clock_offset_ms: number;
    measured_at: number;
    max_abs_offset_ms: number;
    max_measured_at: number;
    app_version: string;
  };
  const device = () => env.DB.prepare("SELECT * FROM devices WHERE device_id = ?1").bind(DEVICE_A).first<DeviceRow>();
  const call = (now: number, deviceTime: number, appVersion: string) =>
    runSync(env.DB, syncRequestSchema.parse(syncBody({ deviceTime, appVersion })), { now });

  it("同期の要求の差とアプリのリリースを、端末の行に保存する", async () => {
    const before = Date.now();
    await sync({ deviceTime: before - 5000, appVersion: "v1.2.0" });
    const row = await device();
    expect(row?.app_version).toBe("v1.2.0");
    expect(row?.clock_offset_ms).toBeGreaterThanOrEqual(5000);
    expect(row?.clock_offset_ms).toBeLessThan(15_000);
    expect(row?.max_abs_offset_ms).toBe(row?.clock_offset_ms);
    expect(row?.measured_at).toBeGreaterThanOrEqual(before);
  });

  it("10 分に 1 回だけ書き換え、最大の差とその時刻を持ち続ける", async () => {
    const t0 = 1_764_300_000_000;
    await call(t0, t0 - 1000, "v1.0.0");
    expect(await device()).toEqual({
      device_id: DEVICE_A,
      clock_offset_ms: 1000,
      measured_at: t0,
      max_abs_offset_ms: 1000,
      max_measured_at: t0,
      app_version: "v1.0.0",
    });

    // 10 分に満たなければ、差もリリースも書き換えない
    await call(t0 + DEVICE_MEASURE_INTERVAL_MS - 1, t0 + 999_999, "v1.1.0");
    expect(await device()).toMatchObject({ clock_offset_ms: 1000, measured_at: t0, app_version: "v1.0.0" });

    // 10 分ちょうどで書き換える。端末の時計が進んでいれば差は負で、最大は絶対値で比べる
    const t1 = t0 + DEVICE_MEASURE_INTERVAL_MS;
    await call(t1, t1 + 90_000, "v1.1.0");
    expect(await device()).toMatchObject({
      clock_offset_ms: -90_000,
      measured_at: t1,
      max_abs_offset_ms: 90_000,
      max_measured_at: t1,
      app_version: "v1.1.0",
    });

    // 小さい差では、最新の差だけが変わり、最大とその時刻は残る
    const t2 = t1 + DEVICE_MEASURE_INTERVAL_MS;
    await call(t2, t2 - 20, "v1.1.0");
    expect(await device()).toMatchObject({
      clock_offset_ms: 20,
      measured_at: t2,
      max_abs_offset_ms: 90_000,
      max_measured_at: t1,
    });
  });
});

describe("同期: 401、400、413、403（Design Doc 4.5、7.1、9.3）", () => {
  const post = (body: unknown, headers: Record<string, string> = {}) => postSync(body, { headers });

  it("セッションがないか、期限切れなら 401 で、記録を保存しない", async () => {
    const body = JSON.stringify(syncBody({ records: [checkin()] }));
    const headers = { "Content-Type": "application/json" };
    const none = await request("/api/sync", { method: "POST", headers, body });
    expect(none.status).toBe(401);
    expect(await none.json()).toEqual({ error: "unauthorized" });

    const expired = await signSession(env.SESSION_SECRET, { ...operator, exp: Date.now() - 1 });
    expect((await request("/api/sync", { method: "POST", headers, body, session: expired })).status).toBe(401);
    expect(await countRecords()).toBe(0);
  });

  it("スキーマに合わない要求は 400 で、記録を 1 件も保存しない", async () => {
    const good = checkin();
    const invalid: unknown[] = [
      // 知らないプロトコルの版。いまの版だけを受け付ける（Design Doc 9.6）
      { ...syncBody(), v: SYNC_PROTOCOL_VERSION + 1 },
      { ...syncBody(), v: SYNC_PROTOCOL_VERSION - 1 },
      { ...syncBody(), v: undefined },
      { ...syncBody(), deviceId: DEVICE_A.toUpperCase() },
      { ...syncBody(), appVersion: "v".repeat(65) },
      { ...syncBody(), limit: 0 },
      { ...syncBody(), limit: 201 },
      { ...syncBody(), cursor: { generation: "g", seq: -1 } },
      { ...syncBody(), records: undefined },
      // 件数の上限（50 件）
      syncBody({ records: Array.from({ length: 51 }, () => checkin()) }),
      // 通る記録と通らない記録が混ざっていれば、通る記録も保存しない
      { ...syncBody(), records: [good, { ...checkin(), reasonText: "x" }] },
      { ...syncBody(), records: [good, { ...checkin(), reception: null }] },
      { ...syncBody(), records: [good, { ...checkin(), ticketToken: "short" }] },
      { ...syncBody(), records: [good, { ...checkin(), operatorId: "abc" }] },
      { ...syncBody(), records: [good, { ...checkin(), userName: "x".repeat(101) }] },
      { ...syncBody(), records: [good, { ...cancel(), targetRecordIds: [] }] },
      { ...syncBody(), records: [good, { ...cancel(), reasonKind: "other", reasonText: "x".repeat(2001) }] },
      { ...syncBody(), records: [good, { ...cancel(), targetRecordIds: Array.from({ length: 51 }, () => crypto.randomUUID()) }] },
      "{",
      "null",
      "[]",
      "",
    ];
    for (const body of invalid) {
      const res = await post(body);
      expect(res.status, JSON.stringify(body).slice(0, 80)).toBe(400);
      expect(await res.json()).toEqual({ error: "bad_request" });
    }
    expect(await countRecords()).toBe(0);
  });

  it("現在のプロトコルの版の要求のフィクスチャを受け付ける", async () => {
    // 4.5 の要求の形そのまま
    const fixture = {
      v: 0,
      deviceId: "c2d4e6f8-0000-4000-8000-000000000000",
      deviceTime: 1764300000000,
      appVersion: "v1.2.0",
      cursor: { generation: "k7Qm", seq: 1234 },
      limit: 200,
      records: [
        {
          recordId: "9f1c0000-0000-4000-8000-000000000000",
          opId: "3a7e0000-0000-4000-8000-000000000000",
          op: "checkin",
          ticketToken: "aRZAnjQt1sepvZ2OTJLNQZ1MsAI93cAw",
          userName: "karupanerura",
          ticketNo: "A-12",
          reception: "eve",
          route: "qr",
          reasonKind: null,
          reasonText: null,
          targetRecordIds: null,
          deviceTime: 1764300000000,
          deviceId: "c2d4e6f8-0000-4000-8000-000000000000",
          operatorId: "123456789012345678",
          operatorName: "karupanerura",
        },
      ],
    };
    const res = await post(fixture);
    expect(res.status).toBe(200);
    expect(await countRecords()).toBe(1);
  });

  it("本文が 256 KiB を超えれば 413 で、記録を保存しない", async () => {
    const records = Array.from({ length: 50 }, () => cancel({ reasonKind: "other", reasonText: "あ".repeat(2000) }));
    const body = JSON.stringify(syncBody({ records }));
    expect(new TextEncoder().encode(body).byteLength).toBeGreaterThan(SYNC_BODY_MAX_BYTES);

    const res = await post(body);
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "payload_too_large" });

    // Content-Length のない本文（ストリーム）も、読みながら数えて断る
    const bytes = new TextEncoder().encode(body);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < bytes.byteLength; i += 16_384) controller.enqueue(bytes.slice(i, i + 16_384));
        controller.close();
      },
    });
    const streamed = await request("/api/sync", {
      method: "POST",
      session: await validSession(),
      headers: { "Content-Type": "application/json" },
      body: stream,
      duplex: "half",
    } as RequestInit);
    expect(streamed.status).toBe(413);
    expect(await countRecords()).toBe(0);
  });

  it("上限に収まる大きな本文は受け付ける", async () => {
    // 端末が区切る 200 KiB の手前（Design Doc 6.6）
    const records = Array.from({ length: 30 }, () => cancel({ reasonKind: "other", reasonText: "あ".repeat(2000) }));
    expect((await post(syncBody({ records, limit: 1 }))).status).toBe(200);
    expect(await countRecords()).toBe(30);
  });

  it("同じオリジンでない要求は 403 で、記録を保存しない", async () => {
    const body = syncBody({ records: [checkin()] });
    for (const headers of [
      { "Sec-Fetch-Site": "same-site" },
      { "Sec-Fetch-Site": "cross-site" },
      { "Sec-Fetch-Site": "none" },
    ]) {
      const res = await post(body, headers);
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "forbidden" });
    }
    // Sec-Fetch-Site がなければ、Origin を照合する
    const session = await validSession();
    const byOrigin = (origin: string) =>
      request("/api/sync", {
        method: "POST",
        session,
        headers: { "Content-Type": "application/json", Origin: origin },
        body: JSON.stringify(body),
      });
    expect((await byOrigin("https://other.checkin.test")).status).toBe(403);
    expect((await byOrigin("https://evil.example")).status).toBe(403);
    expect(await countRecords()).toBe(0);
    expect((await byOrigin("https://checkin.test")).status).toBe(200);
  });

  it("Content-Type が application/json でなければ 400 で、記録を保存しない", async () => {
    const body = syncBody({ records: [checkin()] });
    for (const contentType of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data"]) {
      const res = await post(body, { "Content-Type": contentType });
      expect(res.status).toBe(400);
    }
    expect(await countRecords()).toBe(0);
    expect((await post(body, { "Content-Type": "application/json; charset=utf-8" })).status).toBe(200);
  });
});

describe("同期: セッションの延長（Design Doc 7.2）", () => {
  const sessionWithRemaining = (remaining: number) =>
    signSession(env.SESSION_SECRET, { ...operator, exp: Date.now() + remaining });

  it("残りが 6 日を切っていなければ、Cookie を付けない", async () => {
    const res = await postSync(syncBody(), { session: await sessionWithRemaining(6 * DAY + 60_000) });
    expect(res.status).toBe(200);
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  it("残りが 6 日を切っていれば、期限を 7 日後にしたセッションを、同じ属性の Cookie で返す", async () => {
    const before = Date.now();
    const res = await postSync(syncBody(), { session: await sessionWithRemaining(6 * DAY - 60_000) });
    expect(res.status).toBe(200);

    const cookies = res.headers.getSetCookie();
    expect(cookies).toHaveLength(1);
    const cookie = cookies[0]!;
    expect(cookie).toMatch(/^__Host-session=[^;]+;/);
    expect(cookie).toMatch(/Max-Age=604800/);
    expect(cookie).toMatch(/Path=\//);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/Secure/);
    expect(cookie).toMatch(/SameSite=Lax/);
    expect(cookie).not.toMatch(/Domain=/i);

    const token = decodeURIComponent(cookie.slice(`${SESSION_COOKIE}=`.length, cookie.indexOf(";")));
    const renewed = await verifySession(env.SESSION_SECRET, token, Date.now());
    expect(renewed).toMatchObject(operator);
    expect(renewed!.exp).toBeGreaterThanOrEqual(before + 7 * DAY);
    expect(renewed!.exp).toBeLessThanOrEqual(Date.now() + 7 * DAY);
  });

  it("200 でない応答と、同期でないルートでは、発行し直さない", async () => {
    const session = await sessionWithRemaining(60_000);
    const bad = await postSync({ ...syncBody(), v: 99 }, { session });
    expect(bad.status).toBe(400);
    expect(bad.headers.getSetCookie()).toEqual([]);

    const me = await request("/api/me", { session });
    expect(me.status).toBe(200);
    expect(me.headers.getSetCookie()).toEqual([]);
  });
});

describe("ログ（Design Doc 7.6）", () => {
  afterEach(() => vi.restoreAllMocks());

  function captureLogs() {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    return () => spy.mock.calls.map((args) => String(args[0]));
  }

  it("同期の要求 1 件につき 1 行で、ルート、状態コード、端末 ID、件数、処理時間を出す", async () => {
    const lines = captureLogs();
    const session = await validSession();
    const record = checkin({ userName: "secret-user-name" });
    await postSync(syncBody({ records: [record] }), { session });

    expect(lines()).toHaveLength(1);
    const line = lines()[0]!;
    expect(JSON.parse(line)).toEqual({
      route: "/api/sync",
      method: "POST",
      status: 200,
      deviceId: DEVICE_A,
      sent: 1,
      returned: 1,
      ms: expect.any(Number),
    });
    // 記録の中身と Cookie は出さない
    for (const secret of [record.userName, record.ticketToken, record.recordId, session, operator.name]) {
      expect(line).not.toContain(secret);
    }
  });

  it("400 では、スキーマの検証で失敗した項目のパスだけを出す", async () => {
    const lines = captureLogs();
    await postSync({ ...syncBody(), appVersion: "secret-value".repeat(10), records: [{ ...checkin(), ticketToken: "secret-token" }] });
    const line = lines()[0]!;
    const parsed = JSON.parse(line) as { status: number; invalid: string[] };
    expect(parsed.status).toBe(400);
    expect(parsed.invalid).toContain("appVersion");
    expect(parsed.invalid.some((path) => path.startsWith("records.0"))).toBe(true);
    expect(line).not.toContain("secret");
  });

  it("想定外の失敗は 500 にして、例外の名前だけを出す", async () => {
    const lines = captureLogs();
    const generation = await currentGeneration();
    try {
      // マイグレーションが入れる世代がない DB
      await env.DB.prepare("DELETE FROM meta WHERE key = 'generation'").run();
      const res = await postSync(syncBody());
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: "internal" });
      expect(res.headers.getSetCookie()).toEqual([]);
    } finally {
      await env.DB.prepare("INSERT INTO meta (key, value) VALUES ('generation', ?1)").bind(generation).run();
    }
    expect(JSON.parse(lines()[0]!)).toEqual({
      route: "/api/sync",
      method: "POST",
      status: 500,
      deviceId: DEVICE_A,
      sent: 0,
      reason: "Error",
      ms: expect.any(Number),
    });
  });

  it("エラーの応答も 1 行で出す", async () => {
    const lines = captureLogs();
    await request("/api/me");
    await request("/unknown?code=secret-code");
    expect(lines().map((l) => JSON.parse(l) as unknown)).toEqual([
      { route: "/api/me", method: "GET", status: 401, ms: expect.any(Number) },
      { route: "/unknown", method: "GET", status: 404, ms: expect.any(Number) },
    ]);
  });
});
