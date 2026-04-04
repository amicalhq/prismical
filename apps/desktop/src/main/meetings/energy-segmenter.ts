export interface SegmentedAudioChunk {
  startSample: number;
  endSample: number;
  startTimeMs: number;
  endTimeMs: number;
  audio: Float32Array;
}

export interface EnergySegmenterOptions {
  sampleRate?: number;
  frameSize?: number;
  speechThreshold?: number;
  minSpeechMs?: number;
  silenceMsToSplit?: number;
  preSpeechPadMs?: number;
  postSpeechPadMs?: number;
  maxSegmentMs?: number;
}

export function segmentAudioByEnergy(
  audio: Float32Array,
  options: EnergySegmenterOptions = {},
): SegmentedAudioChunk[] {
  const sampleRate = options.sampleRate ?? 16000;
  const frameSize = options.frameSize ?? 512;
  const speechThreshold = options.speechThreshold ?? 0.015;
  const minSpeechMs = options.minSpeechMs ?? 500;
  const silenceMsToSplit = options.silenceMsToSplit ?? 2200;
  const preSpeechPadMs = options.preSpeechPadMs ?? 250;
  const postSpeechPadMs = options.postSpeechPadMs ?? 250;
  const maxSegmentMs = options.maxSegmentMs ?? 30000;

  const frameDurationMs = (frameSize / sampleRate) * 1000;
  const silenceFramesToSplit = Math.max(
    1,
    Math.round(silenceMsToSplit / frameDurationMs),
  );
  const preSpeechPadFrames = Math.round(preSpeechPadMs / frameDurationMs);
  const postSpeechPadFrames = Math.round(postSpeechPadMs / frameDurationMs);
  const minSpeechFrames = Math.max(
    1,
    Math.round(minSpeechMs / frameDurationMs),
  );
  const maxSegmentFrames = Math.max(
    1,
    Math.round(maxSegmentMs / frameDurationMs),
  );

  const totalFrames = Math.ceil(audio.length / frameSize);
  const segments: SegmentedAudioChunk[] = [];

  let inSpeech = false;
  let speechStartFrame = 0;
  let lastSpeechFrame = 0;
  let consecutiveSpeechFrames = 0;
  let trailingSilenceFrames = 0;

  for (let frameIndex = 0; frameIndex < totalFrames; frameIndex += 1) {
    const start = frameIndex * frameSize;
    const end = Math.min(start + frameSize, audio.length);
    const frame = audio.subarray(start, end);
    const rms = rootMeanSquare(frame);
    const isSpeech = rms >= speechThreshold;

    if (isSpeech) {
      consecutiveSpeechFrames += 1;
      trailingSilenceFrames = 0;
      lastSpeechFrame = frameIndex;

      if (!inSpeech && consecutiveSpeechFrames >= 1) {
        inSpeech = true;
        speechStartFrame = Math.max(0, frameIndex - preSpeechPadFrames);
      }
    } else {
      consecutiveSpeechFrames = 0;
      if (inSpeech) {
        trailingSilenceFrames += 1;
      }
    }

    if (!inSpeech) {
      continue;
    }

    const activeFrames = frameIndex - speechStartFrame + 1;
    const shouldSplitForSilence = trailingSilenceFrames >= silenceFramesToSplit;
    const shouldSplitForLength = activeFrames >= maxSegmentFrames;

    if (!shouldSplitForSilence && !shouldSplitForLength) {
      continue;
    }

    const segmentEndFrame = shouldSplitForLength
      ? frameIndex
      : Math.min(totalFrames - 1, lastSpeechFrame + postSpeechPadFrames);
    pushSegment({
      segments,
      audio,
      sampleRate,
      frameSize,
      startFrame: speechStartFrame,
      endFrame: segmentEndFrame,
      minSpeechFrames,
    });

    inSpeech = false;
    consecutiveSpeechFrames = 0;
    trailingSilenceFrames = 0;
  }

  if (inSpeech) {
    pushSegment({
      segments,
      audio,
      sampleRate,
      frameSize,
      startFrame: speechStartFrame,
      endFrame: totalFrames - 1,
      minSpeechFrames,
    });
  }

  return segments;
}

function pushSegment(args: {
  segments: SegmentedAudioChunk[];
  audio: Float32Array;
  sampleRate: number;
  frameSize: number;
  startFrame: number;
  endFrame: number;
  minSpeechFrames: number;
}): void {
  const {
    segments,
    audio,
    sampleRate,
    frameSize,
    startFrame,
    endFrame,
    minSpeechFrames,
  } = args;
  const frameCount = endFrame - startFrame + 1;
  if (frameCount < minSpeechFrames) {
    return;
  }

  const startSample = startFrame * frameSize;
  const endSample = Math.min((endFrame + 1) * frameSize, audio.length);
  const segmentAudio = audio.slice(startSample, endSample);

  segments.push({
    startSample,
    endSample,
    startTimeMs: Math.round((startSample / sampleRate) * 1000),
    endTimeMs: Math.round((endSample / sampleRate) * 1000),
    audio: segmentAudio,
  });
}

function rootMeanSquare(frame: Float32Array): number {
  if (frame.length === 0) {
    return 0;
  }

  let total = 0;
  for (let index = 0; index < frame.length; index += 1) {
    total += frame[index] * frame[index];
  }

  return Math.sqrt(total / frame.length);
}
