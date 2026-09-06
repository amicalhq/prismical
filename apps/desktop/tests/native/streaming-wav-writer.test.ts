import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StreamingWavWriter } from "../../src/main/infra/audio/streaming-wav-writer";

/**
 * Round-trip fixture for the imported streaming WAV writer:
 * write float frames + silence, finalize, then parse the RIFF header and
 * PCM payload back out of the file.
 */
describe("StreamingWavWriter", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "prismical-wav-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("round-trips frames through a finalized RIFF/WAVE file", async () => {
    const file = path.join(dir, "capture.wav");
    const writer = new StreamingWavWriter(file, 16_000, 1, 16);

    await writer.appendAudio(new Float32Array([0, 0.5, -0.5, 1, -1]));
    await writer.appendSilence(3);
    await writer.finalize();

    const bytes = fs.readFileSync(file);
    const dataSize = (5 + 3) * 2; // 8 samples × int16

    // RIFF scaffolding
    expect(bytes.toString("ascii", 0, 4)).toBe("RIFF");
    expect(bytes.readUInt32LE(4)).toBe(dataSize + 36);
    expect(bytes.toString("ascii", 8, 12)).toBe("WAVE");

    // fmt chunk
    expect(bytes.toString("ascii", 12, 16)).toBe("fmt ");
    expect(bytes.readUInt32LE(16)).toBe(16);
    expect(bytes.readUInt16LE(20)).toBe(1); // PCM
    expect(bytes.readUInt16LE(22)).toBe(1); // mono
    expect(bytes.readUInt32LE(24)).toBe(16_000);
    expect(bytes.readUInt32LE(28)).toBe(32_000); // byte rate
    expect(bytes.readUInt16LE(32)).toBe(2); // block align
    expect(bytes.readUInt16LE(34)).toBe(16); // bit depth

    // data chunk — the finalize pass must have patched the placeholder size
    expect(bytes.toString("ascii", 36, 40)).toBe("data");
    expect(bytes.readUInt32LE(40)).toBe(dataSize);
    expect(bytes.length).toBe(44 + dataSize);

    // PCM payload: floor(sample * 32767) with [-1, 1] clamping, then silence
    const samples = Array.from({ length: 8 }, (_, i) =>
      bytes.readInt16LE(44 + i * 2),
    );
    expect(samples).toEqual([0, 16383, -16384, 32767, -32767, 0, 0, 0]);

    expect(writer.getDataSize()).toBe(dataSize);
    expect(writer.getFilePath()).toBe(file);
  });

  it("clamps out-of-range samples instead of wrapping", async () => {
    const file = path.join(dir, "clamp.wav");
    const writer = new StreamingWavWriter(file, 16_000, 1, 16);
    await writer.appendAudio(new Float32Array([2, -2]));
    await writer.finalize();

    const bytes = fs.readFileSync(file);
    expect(bytes.readInt16LE(44)).toBe(32_767);
    expect(bytes.readInt16LE(46)).toBe(-32_767);
  });

  it("reports a stream open failure on append and close without an unhandled error", async () => {
    const writer = new StreamingWavWriter(path.join(dir, "missing", "capture.wav"));
    await expect(writer.appendAudio(new Float32Array([0.1]))).rejects.toMatchObject({ code: "ENOENT" });
    expect(writer.getDataSize()).toBe(0);
    await expect(writer.finalize()).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports stream failure when aborted before the first frame", async () => {
    const writer = new StreamingWavWriter(path.join(dir, "missing", "aborted.wav"));
    await expect(writer.abort()).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses appends after finalize and supports abort", async () => {
    const file = path.join(dir, "final.wav");
    const writer = new StreamingWavWriter(file, 16_000, 1, 16);
    await writer.appendAudio(new Float32Array([0.1]));
    await writer.finalize();
    await expect(writer.appendAudio(new Float32Array([0.1]))).rejects.toThrow(
      /finalized/,
    );

    const aborted = new StreamingWavWriter(path.join(dir, "aborted.wav"));
    await aborted.appendAudio(new Float32Array([0.1]));
    await aborted.abort();
    await expect(aborted.appendSilence(4)).rejects.toThrow(/finalized/);
  });
});
