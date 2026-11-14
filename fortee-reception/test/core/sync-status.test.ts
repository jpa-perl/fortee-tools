import { describe, expect, it } from "vitest";
import { pickSyncStatus, type SyncConditions } from "../../src/core/sync.ts";

const none: SyncConditions = { paused: false, syncing: false, offline: false, needsLogin: false, failed: false, hasUnsent: false };

describe("同期の状態の優先順（画面設計書 2.3）", () => {
  it.each([
    ["どれにも当たらなければ、同期済み", {}, "synced"],
    ["未送信の記録があれば、未同期あり", { hasUnsent: true }, "pending"],
    ["同期の失敗は、未同期ありより先", { failed: true, hasUnsent: true }, "failed"],
    ["未送信の記録がなくても、同期の失敗", { failed: true }, "failed"],
    ["再ログインが必要は、同期の失敗より先", { needsLogin: true, failed: true, hasUnsent: true }, "needsLogin"],
    ["オフラインは、再ログインが必要より先", { offline: true, needsLogin: true, failed: true, hasUnsent: true }, "offline"],
    ["オフラインは、未送信の記録がなくてもオフライン", { offline: true }, "offline"],
    ["同期中は、ほかのどれよりも先", { syncing: true, offline: true, needsLogin: true, failed: true, hasUnsent: true }, "syncing"],
    ["同期中は、未同期ありより先", { syncing: true, hasUnsent: true }, "syncing"],
    ["同期の停止は、ほかのどれよりも先", { paused: true, syncing: true, offline: true, failed: true, hasUnsent: true }, "paused"],
  ] as const)("%s", (_name, conditions, expected) => {
    expect(pickSyncStatus({ ...none, ...conditions })).toBe(expected);
  });

  it("条件のすべての組み合わせで、順に見て最初に当てはまったものを返す", () => {
    const order = [
      ["paused", "paused"],
      ["syncing", "syncing"],
      ["offline", "offline"],
      ["needsLogin", "needsLogin"],
      ["failed", "failed"],
      ["hasUnsent", "pending"],
    ] as const;
    for (let bits = 0; bits < 64; bits++) {
      const conditions = { ...none };
      order.forEach(([key], i) => {
        conditions[key] = (bits & (1 << i)) !== 0;
      });
      const expected = order.find(([key]) => conditions[key])?.[1] ?? "synced";
      expect(pickSyncStatus(conditions)).toBe(expected);
    }
  });
});
