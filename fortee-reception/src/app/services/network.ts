import { publishedConfigSchema } from "../../core/config.ts";
import { snapshotSchema } from "../../core/snapshot.ts";
import { meResponseSchema, syncResponseSchema } from "../../core/sync.ts";
import type { NetResult, Network } from "./ports.ts";

// ネットワーク（同期と配布物の取得。Design Doc 6.6、6.7、6.13）。
// 応答は、ここでスキーマに照らして検証する（Design Doc 4.1）。知らない項目は落ちる。
// 通信は AbortController で打ち切り、打ち切った理由（タイムアウトか、呼び出し側の中断か）を区別する。

/** Design Doc 6.13 の調整値 */
export const SYNC_TIMEOUT_MS = 20_000;
export const DISTRIBUTION_TIMEOUT_MS = 60_000;
export const ME_TIMEOUT_MS = 15_000;

type Parser<T> = { safeParse(value: unknown): { success: true; data: T } | { success: false } };

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export function createNetwork(fetchFn: FetchLike): Network {
  async function request<T>(
    path: string,
    init: RequestInit,
    schema: Parser<T>,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<NetResult<T>> {
    if (signal?.aborted) return { kind: "aborted" };
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort);
    try {
      const response = await fetchFn(path, { ...init, signal: controller.signal, credentials: "same-origin" });
      if (!response.ok) return { kind: "http", status: response.status };
      // 本文を読み終えるまでを、タイムアウトと中断の対象にする
      const body: unknown = await response.json();
      const parsed = schema.safeParse(body);
      return parsed.success ? { kind: "ok", value: parsed.data } : { kind: "invalid" };
    } catch (error) {
      if (signal?.aborted) return { kind: "aborted" };
      if (timedOut) return { kind: "timeout" };
      // JSON として読めない本文
      if (error instanceof SyntaxError) return { kind: "invalid" };
      return { kind: "network" };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  return {
    sync: (body, signal) =>
      request(
        "/api/sync",
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
        syncResponseSchema,
        SYNC_TIMEOUT_MS,
        signal,
      ),
    fetchConfig: (version, signal) =>
      request(`/api/config/${version}`, { method: "GET" }, publishedConfigSchema, DISTRIBUTION_TIMEOUT_MS, signal),
    fetchSnapshot: (eventId, version, signal) =>
      request(
        `/api/snapshot/${encodeURIComponent(eventId)}/${version}`,
        { method: "GET" },
        snapshotSchema,
        DISTRIBUTION_TIMEOUT_MS,
        signal,
      ),
    fetchMe: () => request("/api/me", { method: "GET" }, meResponseSchema, ME_TIMEOUT_MS),
    async logout() {
      try {
        await fetchFn("/auth/logout", { method: "POST", credentials: "same-origin", keepalive: true });
      } catch {
        // 送信は失敗してよい。端末のデータの消去が正の処理である（Design Doc 6.4）
      }
    },
  };
}
