export class StreamingLinearResampler {
  private buffer: Float32Array<ArrayBufferLike> = new Float32Array(0);
  private sourcePosition = 0;

  constructor(
    private readonly inputSampleRate: number,
    private readonly outputSampleRate: number,
  ) {}

  process(
    chunk: Float32Array<ArrayBufferLike>,
  ): Float32Array<ArrayBufferLike> {
    if (chunk.length === 0) {
      return new Float32Array(0);
    }

    if (this.inputSampleRate === this.outputSampleRate) {
      return chunk.slice();
    }

    this.buffer = this.concatFloat32(this.buffer, chunk);
    if (this.buffer.length < 2) {
      return new Float32Array(0);
    }

    const ratio = this.inputSampleRate / this.outputSampleRate;
    const output: number[] = [];

    while (this.sourcePosition + 1 < this.buffer.length) {
      const lowerIndex = Math.floor(this.sourcePosition);
      const upperIndex = Math.min(lowerIndex + 1, this.buffer.length - 1);
      const fraction = this.sourcePosition - lowerIndex;
      const lowerValue = this.buffer[lowerIndex];
      const upperValue = this.buffer[upperIndex];

      output.push(lowerValue + (upperValue - lowerValue) * fraction);
      this.sourcePosition += ratio;
    }

    const consumedSamples = Math.min(
      Math.floor(this.sourcePosition),
      Math.max(0, this.buffer.length - 1),
    );

    if (consumedSamples > 0) {
      this.buffer = this.buffer.slice(consumedSamples);
      this.sourcePosition -= consumedSamples;
    }

    return Float32Array.from(output);
  }

  flush(): Float32Array<ArrayBufferLike> {
    if (this.inputSampleRate === this.outputSampleRate) {
      const remaining = this.buffer;
      this.reset();
      return remaining;
    }

    if (this.buffer.length === 0) {
      return new Float32Array(0);
    }

    const ratio = this.inputSampleRate / this.outputSampleRate;
    const output: number[] = [];

    while (this.sourcePosition < this.buffer.length) {
      const lowerIndex = Math.floor(this.sourcePosition);
      const upperIndex = Math.min(lowerIndex + 1, this.buffer.length - 1);
      const fraction = this.sourcePosition - lowerIndex;
      const lowerValue = this.buffer[Math.min(lowerIndex, this.buffer.length - 1)];
      const upperValue = this.buffer[upperIndex];

      output.push(lowerValue + (upperValue - lowerValue) * fraction);
      this.sourcePosition += ratio;
    }

    this.reset();
    return Float32Array.from(output);
  }

  reset(): void {
    this.buffer = new Float32Array(0);
    this.sourcePosition = 0;
  }

  private concatFloat32(
    left: Float32Array<ArrayBufferLike>,
    right: Float32Array<ArrayBufferLike>,
  ): Float32Array<ArrayBufferLike> {
    if (left.length === 0) {
      return right.slice();
    }

    const output = new Float32Array(left.length + right.length);
    output.set(left, 0);
    output.set(right, left.length);
    return output;
  }
}
