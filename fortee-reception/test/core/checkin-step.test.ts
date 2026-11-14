import { describe, expect, it } from "vitest";
import { checkinStep, type Judgement, newlyDoneOf } from "../../src/core/judge.ts";
import { checkin, config, MAIN, ticket } from "./helpers.ts";

// QR の読み取りの判定の後に、確認を挟むか（FR-49）

const alice = ticket({ eventId: MAIN, userName: "alice" });
const user = { userName: "alice", name: "", tickets: [] };
const reception = config.receptions[0];
if (reception === undefined) throw new Error("設定に受付がない");

const judgements: Record<Judgement["kind"], Judgement> = {
  success: { kind: "success", user, newlyDone: [alice] },
  continue: { kind: "continue", user, newlyDone: [alice], remainingEvents: [MAIN] },
  alreadyDone: { kind: "alreadyDone", user, basis: checkin(1, alice.ticketToken, 0) },
  suggestSwitch: { kind: "suggestSwitch", user, reception, outOfPeriod: false },
  outOfScope: { kind: "outOfScope", user },
  rejected: { kind: "rejected", user, message: "" },
  noTicketToCheckIn: { kind: "noTicketToCheckIn", user, checkInEvents: [MAIN] },
};

describe("通常受付の確認を挟むか（FR-49）", () => {
  it.each([
    ["成功は、通常受付では確認する", judgements.success, false, "confirm"],
    ["成功は、高速受付では確認しない", judgements.success, true, "record"],
    ["続けて読み取りは、新たに済みにするチケットがあれば、通常受付では確認する", judgements.continue, false, "confirm"],
    ["続けて読み取りは、高速受付では確認しない", judgements.continue, true, "record"],
    [
      "続けて読み取りでも、新たに済みにするチケットがなければ、確認しない",
      { ...judgements.continue, newlyDone: [] } as Judgement,
      false,
      "record",
    ],
    ["済みは、確認しない", judgements.alreadyDone, false, "record"],
    ["切替提案は、確認しない", judgements.suggestSwitch, false, "record"],
    ["対象外は、確認しない", judgements.outOfScope, false, "record"],
    ["拒否は、確認しない", judgements.rejected, false, "record"],
    ["チケットなしは、確認しない", judgements.noTicketToCheckIn, false, "record"],
  ] as const)("%s", (_name, judgement, fastCheckin, expected) => {
    expect(checkinStep(judgement, fastCheckin)).toBe(expected);
  });

  it("新たに済みにするチケットは、成功と続けて読み取りだけが持つ", () => {
    for (const judgement of Object.values(judgements)) {
      const expected = judgement.kind === "success" || judgement.kind === "continue" ? [alice] : [];
      expect(newlyDoneOf(judgement)).toEqual(expected);
    }
  });
});
