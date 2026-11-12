import { describe, expect, it } from "vitest";
import { deviceCode, deviceName } from "../../src/core/device.ts";

describe("端末名（Design Doc 9.1）", () => {
  it("端末 ID の先頭の 20 ビットを、5 ビットずつ 4 文字にする", () => {
    expect(deviceCode("00000000-0000-4000-8000-000000000000")).toBe("2222");
    expect(deviceCode("fffff000-0000-4000-8000-000000000000")).toBe("ZZZZ");
    // 0x08864 = 00001 00010 00011 00100
    expect(deviceCode("08864000-0000-4000-8000-000000000000")).toBe("3456");
    expect(deviceName("08864000-0000-4000-8000-000000000000")).toBe("端末 3456");
  });

  it("21 ビット目より後ろは使わない", () => {
    expect(deviceName("08864fff-ffff-4fff-bfff-ffffffffffff")).toBe("端末 3456");
  });

  it("見間違えやすい文字（0、1、I、O）を使わない", () => {
    for (let bits = 0; bits < 32; bits++) {
      const hex = (bits << 15).toString(16).padStart(5, "0");
      expect(deviceCode(`${hex}000-0000-4000-8000-000000000000`)).toMatch(/^[2-9A-HJ-NP-Z]{4}$/);
    }
  });
});
