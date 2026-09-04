import { describe, it, expect } from "vitest";
import { encodeWavPcm16 } from "./wav-encode";

function dv(buf: ArrayBuffer) {
  return new DataView(buf);
}

describe("encodeWavPcm16", () => {
  it("writes a valid 44-byte RIFF header + 16-bit data", () => {
    const samples = new Float32Array([0, 0.5, -0.5, 1]);
    const buf = encodeWavPcm16(samples, 16000);
    const v = dv(buf);
    expect(String.fromCharCode(v.getUint8(0), v.getUint8(1), v.getUint8(2), v.getUint8(3))).toBe("RIFF");
    expect(String.fromCharCode(v.getUint8(8), v.getUint8(9), v.getUint8(10), v.getUint8(11))).toBe("WAVE");
    expect(v.getUint16(20, true)).toBe(1); // integer PCM
    expect(v.getUint16(22, true)).toBe(1); // mono
    expect(v.getUint32(24, true)).toBe(16000);
    expect(v.getUint16(34, true)).toBe(16); // bits per sample
    expect(v.getUint32(40, true)).toBe(8); // 4 samples * 2 bytes
    expect(buf.byteLength).toBe(44 + 8);
  });

  it("clamps out-of-range floats instead of wrapping", () => {
    const buf = encodeWavPcm16(new Float32Array([2, -2]), 16000);
    const v = dv(buf);
    expect(v.getInt16(44, true)).toBe(32767);
    expect(v.getInt16(46, true)).toBe(-32768);
  });
});
