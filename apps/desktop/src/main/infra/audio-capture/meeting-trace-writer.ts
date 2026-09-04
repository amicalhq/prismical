import * as fs from "node:fs";
import * as path from "node:path";

type TraceValue =
  | string
  | number
  | boolean
  | null
  | TraceValue[]
  | { [key: string]: TraceValue };

interface AudioAppendResult {
  byteOffset: number;
  sampleOffset: number;
  sampleCount: number;
  filePath: string;
}

export class MeetingTraceWriter {
  private readonly traceDirectory: string;
  private readonly jsonlPath: string;
  private readonly jsonlStream: fs.WriteStream;
  private readonly audioStreams = new Map<string, fs.WriteStream>();
  private readonly audioByteOffsets = new Map<string, number>();
  private writeChain: Promise<void> = Promise.resolve();
  private isClosed = false;

  constructor(traceDirectory: string) {
    this.traceDirectory = traceDirectory;
    this.jsonlPath = path.join(traceDirectory, "app-trace.jsonl");
    fs.mkdirSync(traceDirectory, { recursive: true });
    this.jsonlStream = fs.createWriteStream(this.jsonlPath);
  }

  getTraceJsonlPath(): string {
    return this.jsonlPath;
  }

  getTraceAudioPath(channel: string): string {
    return path.join(this.traceDirectory, `${channel}.f32le`);
  }

  async recordEvent(
    event: string,
    metadata: Record<string, TraceValue> = {},
  ): Promise<void> {
    this.enqueue(async () => {
      await this.writeJsonLine({
        loggedAtEpochMs: Date.now(),
        event,
        ...metadata,
      });
    });

    await this.writeChain;
  }

  async recordAudioEvent(
    event: string,
    channel: string,
    samples: Float32Array,
    metadata: Record<string, TraceValue> = {},
  ): Promise<void> {
    this.enqueue(async () => {
      const audio = await this.appendFloat32Samples(channel, samples);
      await this.writeJsonLine({
        loggedAtEpochMs: Date.now(),
        event,
        traceChannel: channel,
        traceFilePath: audio.filePath,
        traceByteOffset: audio.byteOffset,
        traceSampleOffset: audio.sampleOffset,
        traceSampleCount: audio.sampleCount,
        ...metadata,
      });
    });

    await this.writeChain;
  }

  async close(): Promise<void> {
    if (this.isClosed) {
      return;
    }

    this.isClosed = true;
    await this.writeChain;

    await Promise.all(
      [...this.audioStreams.values()].map(
        (stream) =>
          new Promise<void>((resolve) => {
            stream.end(() => resolve());
          }),
      ),
    );

    this.audioStreams.clear();
    this.audioByteOffsets.clear();

    await new Promise<void>((resolve) => {
      this.jsonlStream.end(() => resolve());
    });
  }

  private enqueue(operation: () => Promise<void>): void {
    this.writeChain = this.writeChain.then(async () => {
      if (this.isClosed) {
        return;
      }

      await operation();
    });
  }

  private async appendFloat32Samples(
    channel: string,
    samples: Float32Array,
  ): Promise<AudioAppendResult> {
    const filePath = path.join(this.traceDirectory, `${channel}.f32le`);
    let stream = this.audioStreams.get(channel);
    if (!stream) {
      stream = fs.createWriteStream(filePath);
      this.audioStreams.set(channel, stream);
      this.audioByteOffsets.set(channel, 0);
    }

    const byteOffset = this.audioByteOffsets.get(channel) ?? 0;
    const buffer = Buffer.from(
      samples.buffer.slice(
        samples.byteOffset,
        samples.byteOffset + samples.byteLength,
      ),
    );

    await new Promise<void>((resolve, reject) => {
      stream!.write(buffer, (error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });

    this.audioByteOffsets.set(channel, byteOffset + buffer.length);

    return {
      byteOffset,
      sampleOffset: byteOffset / 4,
      sampleCount: samples.length,
      filePath,
    };
  }

  private async writeJsonLine(
    payload: Record<string, TraceValue>,
  ): Promise<void> {
    const line = `${JSON.stringify(payload)}\n`;
    await new Promise<void>((resolve, reject) => {
      this.jsonlStream.write(line, (error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
  }
}
