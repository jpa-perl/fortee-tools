import { type CheckinRecord, checkinRecordSchema } from "../../core/record.ts";
import { type CancelReason, createCancelRecords } from "../../core/records.ts";
import { operations, ticketStates } from "../state/derived.ts";
import {
  busy,
  confirmedReception,
  type DeviceRecord,
  deviceId,
  now,
  operator,
  overlay,
  records,
  screen,
} from "../state/model.ts";
import { addRecords } from "../storage/db.ts";
import { showNotice } from "./reception.ts";
import { enqueue, rt, setOverlay } from "./runtime.ts";

// 取り消し（S08-M1。Design Doc 6.2、FR-29）。

export type { CancelReason };

/**
 * S08-M1 の「取り消す」。その時点の記録で根拠を求め直し、選んだチケットのうち、開いている記録がまだ根拠に
 * なっているものごとに取り消しの記録を作る。取り消しの記録は、そのチケットの打ち消されていない
 * チェックインの記録をすべて指す。根拠でなくなったチケットは取り消さず、知らせる（画面設計書 S08）。
 * 受付なしのときも取り消せる（FR-7）。確定した後は S08 にとどまる
 *
 * @param ticketTokens 取り消すと選んだチケット（views.ts の operationView().cancellable から選ぶ）
 * @param reason 理由。区分が other のときは、自由記述（2,000 文字まで。入力で止める）を持つ
 */
export async function confirmCancel(ticketTokens: readonly string[], reason: CancelReason): Promise<void> {
  const current = screen.value;
  if (overlay.value?.id !== "S08-M1" || current.id !== "S08" || busy.value) return;
  if (ticketTokens.length === 0) return;
  // 「その他」は自由記述が必須である（FR-29、画面設計書 S08-M1）。画面が入力で止めるが、ここでも確定させない
  if (reason.kind === "other" && reason.text.trim() === "") return;
  const opId = current.opId;
  busy.value = true;
  try {
    await enqueue(async (db) => {
      const device = deviceId.value;
      const who = operator.value;
      const operation = operations.value.find((candidate) => candidate.opId === opId);
      if (device === null || who === null || operation === undefined || operation.op !== "checkin") {
        setOverlay(null);
        return;
      }
      const time = rt.ports.platform.now();
      now.value = time;
      const selected = new Set(ticketTokens);
      const from: CheckinRecord[] = operation.records.filter((record) => selected.has(record.ticketToken));
      // 確定した時点の集約で行う。確認を開いた後に、他端末の記録が届いていることがある
      const { records: created, skipped } = createCancelRecords({
        from,
        states: ticketStates.value,
        opId: rt.ports.platform.randomUUID(),
        newRecordId: rt.ports.platform.randomUUID,
        reception: confirmedReception.value.reception?.id ?? null,
        reason,
        deviceTime: time,
        deviceId: device,
        operator: who,
      });
      // 作った記録を検証する（Design Doc 4.1）。上限を超える自由記述を持つ記録は、保存せずに S99 に移る。
      // 保存すると、その記録を含む同期が拒まれ続け、後に作った記録も送れなくなる
      for (const record of created) {
        if (!checkinRecordSchema.safeParse(record).success) throw new Error("作った記録が、記録の形に合わない");
      }
      if (created.length > 0) {
        const stored = created.map((record): DeviceRecord => ({ ...record, sent: false, seq: null, receivedAt: null }));
        await addRecords(db, stored);
        records.value = [...records.value, ...stored];
      }
      setOverlay(null);
      // 選んだチケットがこの操作の記録に 1 つもなければ、何も取り消していないので知らせない
      if (created.length === 0 && skipped.length === 0) return;
      showNotice([
        skipped.length > 0
          ? { kind: "cancelSkipped", ticketNos: skipped.map((record) => record.ticketNo) }
          : { kind: "cancelled" },
      ]);
    });
  } finally {
    busy.value = false;
  }
}
