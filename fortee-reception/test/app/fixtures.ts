import { expect } from "vitest";
import type { Ticket } from "../../src/core/snapshot.ts";
import { DATABASE_NAME, type Meta, type StoredData } from "../../src/app/storage/db.ts";
import { config, EVE, jst, MAIN, PARTY, snapshotsOf, ticket } from "../core/helpers.ts";
import { createWorld, type Instance, launch, type LaunchOptions, settle, type World } from "./harness.ts";

// 受付アプリのテストで使う参加者と、よく使う操作。設定は core のテストと同じ（Design Doc 4.2 の例）

/** 本編受付の期間中（11/28 9:30〜17:30） */
export const IN_MAIN = jst(2026, 11, 28, 10, 0);
/** すべての期間の後 */
export const AFTER_ALL = jst(2026, 11, 30, 10, 0);

export type Attendees = {
  /** 本編のチケットを 1 枚 */
  alice: Ticket;
  /** 本編のチケットを 2 枚 */
  bob1: Ticket;
  bob2: Ticket;
  /** 前夜祭のチケットだけ */
  carol: Ticket;
  /** 懇親会のチケットだけ */
  dave: Ticket;
  /** 本編のチケットを 1 枚ずつ持つ、その他の参加者 */
  crowd: Ticket[];
};

export function attendees(): Attendees {
  return {
    alice: ticket({ eventId: MAIN, userName: "alice", name: "Alice", answers: { "Tシャツのサイズ": "L" } }),
    bob1: ticket({ eventId: MAIN, userName: "bob" }),
    bob2: ticket({ eventId: MAIN, userName: "bob" }),
    carol: ticket({ eventId: EVE, userName: "carol" }),
    dave: ticket({ eventId: PARTY, userName: "dave" }),
    crowd: Array.from({ length: 30 }, (_, i) => ticket({ eventId: MAIN, userName: `crowd-${i}` })),
  };
}

export const allTickets = (people: Attendees): Ticket[] => [
  people.alice,
  people.bob1,
  people.bob2,
  people.carol,
  people.dave,
  ...people.crowd,
];

export const qr = (target: Ticket): string => `fortee:${target.ticketToken}`;

/** 公開済みのサーバを持つ世界 */
export function publishedWorld(now: number = IN_MAIN): { world: World; people: Attendees } {
  const world = createWorld(now);
  const people = attendees();
  world.server.publish(config, snapshotsOf(allTickets(people)));
  return { world, people };
}

/** 新しい版の設定とスナップショットを公開する。n は、最初の公開からの版の差 */
export function republish(
  world: World,
  tickets: Ticket[],
  n: number,
  change: (base: typeof config) => typeof config = (base) => base,
): typeof config {
  const next = change({ ...config, version: config.version + n });
  world.server.publish(
    next,
    snapshotsOf(tickets).map((snapshot) => ({ ...snapshot, version: snapshot.version + n })),
  );
  return next;
}

/** Discord から戻ってきた画面を起動し、ホームの停止中に着くまで進める */
export async function ready(world: World, options: LaunchOptions = {}): Promise<Instance> {
  const app = await launch(world, { login: "ok", ...options });
  expect(app.model.screen.value).toEqual({ id: "home", mode: { kind: "idle" } });
  return app;
}

/** 停止中から、QR を読み取って結果を出す */
export async function scan(app: Instance, target: Ticket): Promise<void> {
  if (app.model.screen.value.id === "home" && app.model.screen.value.mode.kind === "idle") app.commands.startScan();
  await settle();
  app.scan.handleDecoded(qr(target));
  await settle();
}

/** 結果から、停止中に戻す（主ボタンで読み取り中にしてから「終了」） */
export async function finish(app: Instance): Promise<void> {
  app.commands.nextFromResult();
  await settle();
  app.commands.stopScan();
  await settle();
}

/** いまの結果の種類。結果を出していなければ null */
export function resultKind(app: Instance): string | null {
  const current = app.model.screen.value;
  if (current.id !== "home") return null;
  if (current.mode.kind === "notFound") return "notFound";
  return current.mode.kind === "result" ? current.mode.judgement.kind : null;
}

/** IndexedDB の中身を、受付アプリの接続とは別に読む */
export async function dump(): Promise<{ meta: Partial<Meta>; data: StoredData }> {
  const request = indexedDB.open(DATABASE_NAME);
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const all = <T>(store: string, keys = false): Promise<T[]> =>
    new Promise((resolve, reject) => {
      const source = db.transaction(store).objectStore(store);
      const got = keys ? source.getAllKeys() : source.getAll();
      got.onsuccess = () => resolve(got.result as T[]);
      got.onerror = () => reject(got.error);
    });
  const keys = await all<string>("meta", true);
  const values = await all<unknown>("meta");
  const result = {
    meta: Object.fromEntries(keys.map((key, i) => [key, values[i]])) as Partial<Meta>,
    data: {
      config: (await all<StoredData["config"]>("config"))[0] ?? null,
      snapshots: await all<StoredData["snapshots"][number]>("snapshots"),
      records: await all<StoredData["records"][number]>("records"),
    },
  };
  db.close();
  return result;
}
