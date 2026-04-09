interface ReferenceEchoCancellerOptions {
  sampleRate?: number;
  maxDelayMs?: number;
  historyMs?: number;
  coarseSearchStep?: number;
  fineSearchStep?: number;
  analysisStride?: number;
  minCorrelation?: number;
  minReferenceRms?: number;
  minScale?: number;
  maxScale?: number;
  residualSuppressionCorrelation?: number;
  residualSuppressionGain?: number;
}

interface AlignmentMatch {
  startIndex: number;
  delaySamples: number;
  correlation: number;
  scale: number;
  referenceRms: number;
}

const DEFAULT_OPTIONS: Required<ReferenceEchoCancellerOptions> = {
  sampleRate: 48_000,
  maxDelayMs: 250,
  historyMs: 400,
  coarseSearchStep: 96,
  fineSearchStep: 8,
  analysisStride: 6,
  minCorrelation: 0.32,
  minReferenceRms: 0.008,
  minScale: 0.06,
  maxScale: 1.35,
  residualSuppressionCorrelation: 0.82,
  residualSuppressionGain: 0.82,
};

class Float32HistoryBuffer {
  private readonly buffer: Float32Array;
  private writeIndex = 0;
  private filled = 0;

  constructor(private readonly capacity: number) {
    this.buffer = new Float32Array(capacity);
  }

  append(samples: Float32Array): void {
    for (let index = 0; index < samples.length; index += 1) {
      this.buffer[this.writeIndex] = samples[index];
      this.writeIndex = (this.writeIndex + 1) % this.capacity;
      this.filled = Math.min(this.filled + 1, this.capacity);
    }
  }

  clear(): void {
    this.writeIndex = 0;
    this.filled = 0;
    this.buffer.fill(0);
  }

  snapshot(maxSamples: number): Float32Array {
    const sampleCount = Math.min(maxSamples, this.filled);
    const output = new Float32Array(sampleCount);
    if (sampleCount === 0) {
      return output;
    }

    const startIndex =
      (this.writeIndex - sampleCount + this.capacity) % this.capacity;

    if (startIndex + sampleCount <= this.capacity) {
      output.set(this.buffer.subarray(startIndex, startIndex + sampleCount));
      return output;
    }

    const firstChunkLength = this.capacity - startIndex;
    output.set(this.buffer.subarray(startIndex), 0);
    output.set(
      this.buffer.subarray(0, sampleCount - firstChunkLength),
      firstChunkLength,
    );
    return output;
  }
}

export class ReferenceEchoCanceller {
  private readonly options: Required<ReferenceEchoCancellerOptions>;
  private readonly history: Float32HistoryBuffer;

  constructor(options: ReferenceEchoCancellerOptions = {}) {
    this.options = {
      ...DEFAULT_OPTIONS,
      ...options,
    };

    const historySamples = Math.max(
      this.options.sampleRate,
      Math.round((this.options.historyMs / 1000) * this.options.sampleRate),
    );
    this.history = new Float32HistoryBuffer(historySamples);
  }

  ingestReferenceFrame(samples: Float32Array): void {
    if (samples.length === 0) {
      return;
    }

    this.history.append(samples);
  }

  processCaptureFrame(samples: Float32Array): Float32Array {
    if (samples.length === 0) {
      return samples;
    }

    const searchWindow = this.history.snapshot(
      this.maxDelaySamples + samples.length,
    );
    if (searchWindow.length < samples.length) {
      return samples;
    }

    const match = this.findBestAlignment(samples, searchWindow);
    if (
      !match ||
      match.correlation < this.options.minCorrelation ||
      match.referenceRms < this.options.minReferenceRms ||
      match.scale < this.options.minScale
    ) {
      return samples;
    }

    const cleaned = new Float32Array(samples.length);
    for (let index = 0; index < samples.length; index += 1) {
      cleaned[index] =
        samples[index] - searchWindow[match.startIndex + index] * match.scale;
    }

    if (match.correlation >= this.options.residualSuppressionCorrelation) {
      for (let index = 0; index < cleaned.length; index += 1) {
        cleaned[index] *= this.options.residualSuppressionGain;
      }
    }

    return cleaned;
  }

  reset(): void {
    this.history.clear();
  }

  private get maxDelaySamples(): number {
    return Math.max(
      0,
      Math.round((this.options.maxDelayMs / 1000) * this.options.sampleRate),
    );
  }

  private findBestAlignment(
    capture: Float32Array,
    referenceWindow: Float32Array,
  ): AlignmentMatch | null {
    const maxStartIndex = referenceWindow.length - capture.length;
    if (maxStartIndex < 0) {
      return null;
    }

    const coarseStart = this.searchRange(
      capture,
      referenceWindow,
      0,
      maxStartIndex,
      this.options.coarseSearchStep,
      this.options.analysisStride,
    );
    if (!coarseStart) {
      return null;
    }

    const fineLowerBound = Math.max(
      0,
      coarseStart.startIndex - this.options.coarseSearchStep,
    );
    const fineUpperBound = Math.min(
      maxStartIndex,
      coarseStart.startIndex + this.options.coarseSearchStep,
    );
    const fineStart = this.searchRange(
      capture,
      referenceWindow,
      fineLowerBound,
      fineUpperBound,
      this.options.fineSearchStep,
      this.options.analysisStride,
    );
    if (!fineStart) {
      return null;
    }

    const exactLowerBound = Math.max(
      0,
      fineStart.startIndex - this.options.fineSearchStep,
    );
    const exactUpperBound = Math.min(
      maxStartIndex,
      fineStart.startIndex + this.options.fineSearchStep,
    );
    const exactStart = this.searchRange(
      capture,
      referenceWindow,
      exactLowerBound,
      exactUpperBound,
      1,
      1,
    );

    return exactStart ?? fineStart;
  }

  private searchRange(
    capture: Float32Array,
    referenceWindow: Float32Array,
    lowerBound: number,
    upperBound: number,
    step: number,
    stride: number,
  ): AlignmentMatch | null {
    let bestMatch: AlignmentMatch | null = null;

    for (
      let startIndex = lowerBound;
      startIndex <= upperBound;
      startIndex += Math.max(1, step)
    ) {
      const stats = correlationStats(
        capture,
        referenceWindow,
        startIndex,
        stride,
      );
      if (!stats || stats.correlation <= 0) {
        continue;
      }

      if (!bestMatch || stats.correlation > bestMatch.correlation) {
        bestMatch = {
          startIndex,
          delaySamples: referenceWindow.length - capture.length - startIndex,
          correlation: stats.correlation,
          scale: clamp(stats.scale, 0, this.options.maxScale),
          referenceRms: stats.referenceRms,
        };
      }
    }

    return bestMatch;
  }
}

function correlationStats(
  capture: Float32Array,
  referenceWindow: Float32Array,
  startIndex: number,
  stride: number,
): { correlation: number; scale: number; referenceRms: number } | null {
  let captureEnergy = 0;
  let referenceEnergy = 0;
  let dot = 0;
  let sampleCount = 0;

  for (let index = 0; index < capture.length; index += Math.max(1, stride)) {
    const captureSample = capture[index];
    const referenceSample = referenceWindow[startIndex + index];

    dot += captureSample * referenceSample;
    captureEnergy += captureSample * captureSample;
    referenceEnergy += referenceSample * referenceSample;
    sampleCount += 1;
  }

  if (
    sampleCount === 0 ||
    captureEnergy <= Number.EPSILON ||
    referenceEnergy <= Number.EPSILON
  ) {
    return null;
  }

  const correlation = dot / Math.sqrt(captureEnergy * referenceEnergy);
  if (!Number.isFinite(correlation) || correlation <= 0) {
    return null;
  }

  return {
    correlation,
    scale: dot / referenceEnergy,
    referenceRms: Math.sqrt(referenceEnergy / sampleCount),
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
