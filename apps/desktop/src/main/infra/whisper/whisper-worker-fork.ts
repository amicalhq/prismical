// Worker process entry point for fork — runs under the bundled Node SIDECAR
// (never inside electron: the RunAsNode fuse is burned). Protocol in protocol.ts;
// the main-process host is engine.ts. Loads @prismical/whisper-wrapper at
// require time, so a missing/incompatible whisper.node kills the worker on
// spawn (the host reports that as 'spawn-failed').
import { Whisper, getLoadedBindingInfo } from "@prismical/whisper-wrapper";
import { shouldDropSegment } from "../audio/segment-filter";
import {
  isSerializedFloat32Array,
  type WhisperDecodeOptions,
  type WorkerLogFrame,
  type WorkerLogLevel,
  type WorkerRequest,
  type WorkerResponse,
  type WorkerTranscription,
} from "./protocol";
import { resolveWhisperGpuDecision } from "./whisper-gpu-policy";

// IPC-based logging — sends structured log messages to the main process
function log(level: WorkerLogLevel, message: string, ...args: unknown[]) {
  const frame: WorkerLogFrame = {
    type: "log",
    level,
    message,
    args: args.map((a) => {
      if (a instanceof Error) return a.message;
      if (typeof a === "object") {
        try {
          return JSON.stringify(a);
        } catch {
          return String(a);
        }
      }
      return a;
    }),
  };
  process.send?.(frame);
}

const logger = {
  transcription: {
    info: (message: string, ...args: unknown[]) =>
      log("info", message, ...args),
    error: (message: string, ...args: unknown[]) =>
      log("error", message, ...args),
    debug: (message: string, ...args: unknown[]) =>
      log("debug", message, ...args),
    warn: (message: string, ...args: unknown[]) =>
      log("warn", message, ...args),
  },
};

let whisperInstance: Whisper | null = null;
let currentModelPath: string | null = null;

// Worker methods
const methods = {
  async initializeModel(modelPath: string): Promise<void> {
    if (whisperInstance && currentModelPath === modelPath) {
      return; // Already initialized with same model
    }

    // Cleanup existing instance
    if (whisperInstance) {
      await whisperInstance.free();
      whisperInstance = null;
      currentModelPath = null;
    }

    // GPU policy: use the GPU everywhere except
    // Intel-only darwin-x64, where ggml Metal returns invalid transcripts.
    const gpuDecision = await resolveWhisperGpuDecision();
    logger.transcription.info(
      `Whisper GPU decision: useGpu=${gpuDecision.useGpu} (${gpuDecision.reason})`,
    );

    whisperInstance = new Whisper(modelPath, { gpu: gpuDecision.useGpu });
    try {
      await whisperInstance.load();
    } catch (e) {
      logger.transcription.error("Failed to load Whisper model:", e);
      throw e;
    }
    currentModelPath = modelPath;
    logger.transcription.info(`Initialized with model: ${modelPath}`);
  },

  async transcribeAudio(
    aggregatedAudio: Float32Array,
    // Passed through VERBATIM to the addon's full(): any key beyond the five
    // the lane sets today (n_threads, beam_size, vad_*) needs no change here.
    options: WhisperDecodeOptions,
  ): Promise<WorkerTranscription> {
    if (!whisperInstance) {
      throw new Error("Whisper instance is not initialized");
    }

    // Pad audio with silence to ensure at least 1 second of audio (16k samples)
    const SAMPLE_RATE = 16000; // Whisper expects 16kHz input
    const originalAudioDurationMs = Math.round(
      (aggregatedAudio.length / SAMPLE_RATE) * 1000,
    );
    const MIN_DURATION_SAMPLES = SAMPLE_RATE * 1 + 4000; // 1 second + extra buffer
    if (aggregatedAudio.length < MIN_DURATION_SAMPLES) {
      const padded = new Float32Array(MIN_DURATION_SAMPLES);
      // Copy the existing audio to the beginning
      padded.set(aggregatedAudio, 0);
      aggregatedAudio = padded;
    }

    const { result } = await whisperInstance.transcribe(
      aggregatedAudio,
      options,
    );
    const transcription = await result;

    // Filter out hallucination/no-speech segments
    const segments = transcription as Array<{
      text: string;
      from?: number;
      to?: number;
      noSpeechProb?: number;
    }>;

    // NEVER log transcript text — these frames land verbatim in the plaintext
    // main log on disk. Counts / probabilities / durations only.
    for (const seg of segments) {
      logger.transcription.debug(
        `Segment [noSpeechProb=${seg.noSpeechProb?.toFixed(3) ?? "N/A"}] ${seg.from ?? "?"}..${seg.to ?? "?"}ms (${seg.text.trim().length} chars)`,
      );
    }

    const keptTextSegments = segments
      .filter((segment) => !shouldDropSegment(segment))
      .filter((segment) => segment.text.trim().length > 0);
    const kept = keptTextSegments
      .filter(
        (segment): segment is typeof segment & { from: number; to: number } =>
          typeof segment.from === "number" && typeof segment.to === "number",
      )
      .map((segment) => ({
        text: segment.text,
        from: Math.max(0, Math.min(segment.from, originalAudioDurationMs)),
        to: Math.max(0, Math.min(segment.to, originalAudioDurationMs)),
        noSpeechProb: segment.noSpeechProb,
      }))
      .filter((segment) => segment.to > segment.from);
    const droppedCount = segments.length - keptTextSegments.length;

    logger.transcription.debug(
      `Segments: ${segments.length} total, ${kept.length} kept, ${droppedCount} dropped`,
    );

    return {
      text: keptTextSegments.map((segment) => segment.text).join(""),
      segments: kept,
    };
  },

  async dispose(): Promise<void> {
    if (whisperInstance) {
      await whisperInstance.free();
      whisperInstance = null;
      currentModelPath = null;
    }
  },

  getBindingInfo(): { path: string; type: string } | null {
    return getLoadedBindingInfo();
  },
};

// Handle messages from parent process
process.on("message", async (message: WorkerRequest) => {
  const { id, method, args } = message;

  try {
    // Deserialize Float32Array from IPC
    const deserializedArgs = args.map((arg) =>
      isSerializedFloat32Array(arg) ? new Float32Array(arg.data) : arg,
    );

    if (method in methods) {
      const methodName = method as keyof typeof methods;
      const fn = methods[methodName] as (
        ...args: unknown[]
      ) => Promise<unknown>;
      const result = await fn(...deserializedArgs);
      const response: WorkerResponse = { id, result };
      process.send!(response);
    } else {
      const response: WorkerResponse = { id, error: `Unknown method: ${method}` };
      process.send!(response);
    }
  } catch (error) {
    const response: WorkerResponse = {
      id,
      error: error instanceof Error ? error.message : String(error),
    };
    process.send!(response);
  }
});

// Send ready signal
logger.transcription.info("Worker process started");
