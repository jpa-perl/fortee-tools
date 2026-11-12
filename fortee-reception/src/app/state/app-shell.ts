import { signal } from "@preact/signals";

/** オフラインで起動できるか（Design Doc 6.11）。まだ判定していなければ null */
export const offlineReady = signal<boolean | null>(null);
