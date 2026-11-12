import { isOfflineReady, onControllerChange, registerServiceWorker } from "../services/app-shell.ts";
import { offlineReady } from "../state/app-shell.ts";

/** オフラインで起動できるかを判定し直す（Design Doc 6.11） */
export async function refreshOfflineReady(): Promise<void> {
  offlineReady.value = await isOfflineReady();
}

/** 起動のたびに Service Worker を登録し、オフラインで起動できるかを判定する */
export function startAppShell(): void {
  registerServiceWorker();
  // 初回のインストールが有効になって controller が付いたときに、判定し直す。再読み込みはしない
  onControllerChange(() => void refreshOfflineReady());
  void refreshOfflineReady();
}
