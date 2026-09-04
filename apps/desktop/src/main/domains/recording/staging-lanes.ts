import * as fs from 'node:fs';
import path from 'node:path';
import { wavFileName } from './recovery-writer';
import type { StageLaneInput } from '../transport/service';

/**
 * Read the finalized per-lane recovery WAVs as staging uploads. Writers are
 * lazy (a mic-only recording never creates system.wav), so presence on disk IS the lane list.
 * Uploads use raw WAV (~345MB/hr per lane at 48kHz mono PCM16); compression (m4a via the capture
 * helper) is the planned follow-up — the server accepts either, keyed by contentType.
 */

/** Whole-session artifacts are read into memory for the PUT — bound it (~2h dual ≈ 1.4GB). */
const MAX_STAGE_BYTES = 1.5 * 1024 * 1024 * 1024;
const WAV_HEADER_BYTES = 44;

export function readStagingLanes(wavDir: string, durationMs: number): StageLaneInput[] {
  // Enforce the cap on stat() sizes BEFORE any read: the cap must bound peak allocation, not
  // just reject after materializing (and readFileSync itself throws above 2GiB).
  const files: { lane: 'mic' | 'system'; filePath: string }[] = [];
  let total = 0;
  for (const lane of ['mic', 'system'] as const) {
    const filePath = path.join(wavDir, wavFileName[lane]);
    if (!fs.existsSync(filePath)) continue;
    const size = fs.statSync(filePath).size;
    if (size <= WAV_HEADER_BYTES) continue;
    total += size;
    files.push({ lane, filePath });
  }
  if (total > MAX_STAGE_BYTES) return [];
  return files.map(({ lane, filePath }) => ({
    lane,
    contentType: 'audio/wav',
    data: fs.readFileSync(filePath),
    durationMs,
  }));
}
