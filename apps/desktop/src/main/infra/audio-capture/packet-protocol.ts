import type { AudioFrame, CapturedAudioSource } from "@/types/meeting";
import { z } from "zod";
import type { MicCaptureEvent } from "../../domains/recording/capture/service";

/**
 * The native audio-capture wire protocol — the ONE place the 32-byte
 * little-endian packet header and the stderr `aec=` line are decoded
 * in one place. Both are fragile contracts
 * with the native helper binary: a protocol change on either side must land
 * here and nowhere else. Do NOT tidy the numbers or the regex — they mirror the
 * bytes the helper emits.
 *
 *   [0]  u8   version          (must be 1)
 *   [1]  u8   source           (1 = mic_raw, 2 = system, 3 = mic_processed)
 *   [2]  u8   format           (must be 1 = float32LE)
 *   [3]  u8   channels         (must be 1)
 *   [4]  u32  sampleRate       (must be 48000)
 *   [8]  u32  sequenceNum
 *   [12] u32  durationMs
 *   [16] u64  timestampMs
 *   [24] u32  payload length in bytes  (packetSize = 32 + this)
 *   [28] u32  sampleStartIndex
 *
 * Payload = raw Float32 PCM → zero-copy `Float32Array`. A non-conforming header
 * THROWS — a hard invariant the wrapper converts into a typed CaptureError so a
 * malformed frame tears the capture down instead of tripping the consumer.
 */

const PACKET_HEADER_SIZE = 32;
const PACKET_VERSION = 1;
const PACKET_FORMAT_FLOAT32 = 1;

/** Scraped from stderr in dual mode — FRAGILE, do not clean up the log line. */
const AEC_MODE_PATTERN = /Dual mode capture started: aec=([a-z0-9-]+)/i;
const MIC_EVENT_PREFIX = "mic-event=";

const micEventSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("bound"),
    uid: z.string().min(1),
    name: z.string().optional(),
    mode: z.string().optional(),
    rev: z.number().int().nonnegative().optional(),
    reason: z.string().optional(),
    blackout_ms: z.number().nonnegative().optional(),
    trimmed_ms: z.number().nonnegative().optional(),
  }),
  z.object({
    kind: z.literal("lost"),
    uid: z.string().min(1),
    rev: z.number().int().nonnegative().optional(),
  }),
  z.object({
    kind: z.literal("bind-failed"),
    uid: z.string().min(1),
    os_status: z.number().optional(),
    reason: z.string().min(1).optional(),
    operation: z.string().min(1).optional(),
    rev: z.number().int().nonnegative().optional(),
  }),
  z.object({ kind: z.literal("unavailable"), rev: z.number().int().nonnegative().optional() }),
  z.object({
    kind: z.literal("recovered"),
    uid: z.string().min(1).optional(),
    rev: z.number().int().nonnegative().optional(),
  }),
  z.object({
    kind: z.literal("timeline-jump"),
    gap_ms: z.number().nonnegative(),
    rev: z.number().int().nonnegative().optional(),
  }),
]);

export interface PacketReader {
  /**
   * Buffer `chunk` and return every whole frame it completes (in wire order).
   * Throws on the first non-conforming header — the caller must treat a throw
   * as a terminal protocol error (the reader's internal buffer is left as-is;
   * a reader is single-use past a throw).
   */
  readonly push: (chunk: Buffer) => AudioFrame[];
}

/** Streaming decoder: reassembles frames across arbitrary chunk boundaries. */
export const createPacketReader = (): PacketReader => {
  let pending = Buffer.alloc(0);
  return {
    push(chunk: Buffer): AudioFrame[] {
      pending = Buffer.concat([pending, chunk]);
      const frames: AudioFrame[] = [];

      while (pending.length >= PACKET_HEADER_SIZE) {
        const header = pending.subarray(0, PACKET_HEADER_SIZE);
        const frameBytes = header.readUInt32LE(24);
        const packetSize = PACKET_HEADER_SIZE + frameBytes;

        if (pending.length < packetSize) {
          break;
        }

        const payload = pending.subarray(PACKET_HEADER_SIZE, packetSize);
        pending = pending.subarray(packetSize);
        frames.push(decodeFrame(header, payload));
      }

      return frames;
    },
  };
};

export const decodeFrame = (header: Buffer, payload: Buffer): AudioFrame => {
  const version = header.readUInt8(0);
  const sourceId = header.readUInt8(1);
  const format = header.readUInt8(2);
  const channels = header.readUInt8(3);
  const sampleRate = header.readUInt32LE(4);
  const sequenceNum = header.readUInt32LE(8);
  const durationMs = header.readUInt32LE(12);
  const timestampMs = Number(header.readBigUInt64LE(16));
  const sampleStartIndex = header.readUInt32LE(28);

  if (version !== PACKET_VERSION) {
    throw new Error(`Unsupported audio packet version: ${version}`);
  }

  if (format !== PACKET_FORMAT_FLOAT32) {
    throw new Error(`Unsupported audio packet format: ${format}`);
  }

  if (channels !== 1 || sampleRate !== 48000) {
    throw new Error(
      `Unexpected audio packet format: sampleRate=${sampleRate} channels=${channels}`,
    );
  }

  return {
    source: decodeSource(sourceId),
    samples: decodeSamples(payload),
    sampleRate,
    channels,
    timestampMs,
    durationMs,
    sequenceNum,
    sampleStartIndex,
  };
};

const decodeSource = (sourceId: number): CapturedAudioSource => {
  switch (sourceId) {
    case 1:
      return "mic_raw";
    case 2:
      return "system";
    case 3:
      return "mic_processed";
    default:
      throw new Error(`Unsupported audio packet source: ${sourceId}`);
  }
};

const decodeSamples = (payload: Buffer): Float32Array => {
  const arrayBuffer = payload.buffer.slice(
    payload.byteOffset,
    payload.byteOffset + payload.byteLength,
  );
  return new Float32Array(arrayBuffer);
};

/** Returns the AEC mode from a dual-mode stderr line, or null if absent. */
export const parseAecMode = (line: string): string | null => {
  const match = line.match(AEC_MODE_PATTERN);
  return match ? match[1] : null;
};

/** Parse one sparse helper control event; ordinary stderr lines return null. */
export const parseMicEvent = (line: string): MicCaptureEvent | null => {
  if (!line.startsWith(MIC_EVENT_PREFIX)) return null;
  try {
    const parsed = micEventSchema.safeParse(JSON.parse(line.slice(MIC_EVENT_PREFIX.length)));
    if (!parsed.success) return null;
    const event = parsed.data;
    switch (event.kind) {
      case "bound":
        return {
          kind: event.kind,
          uid: event.uid,
          name: event.name,
          mode: event.mode,
          rev: event.rev,
          reason: event.reason,
          blackoutMs: event.blackout_ms,
          trimmedMs: event.trimmed_ms,
        };
      case "bind-failed":
        return {
          kind: event.kind,
          uid: event.uid,
          osStatus: event.os_status,
          reason: event.reason,
          operation: event.operation,
          rev: event.rev,
        };
      case "timeline-jump":
        return { kind: event.kind, gapMs: event.gap_ms, rev: event.rev };
      default:
        return event;
    }
  } catch {
    return null;
  }
};
