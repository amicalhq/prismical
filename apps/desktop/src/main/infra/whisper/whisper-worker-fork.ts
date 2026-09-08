// Worker process entry point for fork — runs under the bundled Node SIDECAR
// (never inside electron: the RunAsNode fuse is burned). Protocol in protocol.ts;
// the main-process host is engine.ts. Loads @prismical/whisper-wrapper at
// require time, so a missing/incompatible whisper.node kills the worker on
// spawn (the host reports that as 'spawn-failed').
import { Whisper, getLoadedBindingInfo } from '@prismical/whisper-wrapper';
import { shouldDropSegment } from '@prismical/ai-prompts/transcription';
import {
  isSerializedFloat32Array,
  type WhisperDecodeOptions,
  type WorkerLogLevel,
  type WorkerRequest,
  type WorkerResponse,
  type WorkerTranscription,
} from './protocol';
import { makeFilter, makeWire, byteLength, LIMITS, type LogMetadata } from '@desktop/logging/wire';
import { resolveWhisperGpuDecision } from './whisper-gpu-policy';

// The worker is a transport boundary; main supplies trusted process identity.
const filter = makeFilter({
  isDev: process.env.NODE_ENV !== 'production',
  logLevel: process.env.LOG_LEVEL,
  debugScopes: process.env.LOG_DEBUG_SCOPES,
});
let pendingRecords = 0;
let pendingBytes = 0;
let dropped = 0;
function log(level: WorkerLogLevel, message: string, metadata?: LogMetadata): void {
  if (
    !filter.enabled(level, 'whisper-worker', 'file') &&
    !filter.enabled(level, 'whisper-worker', 'console')
  )
    return;
  if (!process.connected || !process.send) return;
  const frame = { type: 'log' as const, ...makeWire(level, 'whisper-worker', message, metadata) };
  const bytes = byteLength(JSON.stringify(frame));
  if (pendingRecords >= LIMITS.queueRecords || pendingBytes + bytes > LIMITS.queueBytes) {
    dropped++;
    return;
  }
  pendingRecords++;
  pendingBytes += bytes;
  const done = (): void => {
    pendingRecords--;
    pendingBytes -= bytes;
  };
  try {
    process.send(frame, error => {
      done();
      if (!error && dropped) {
        const droppedRecords = dropped;
        dropped = 0;
        log('warn', 'Worker diagnostic records dropped', { context: { droppedRecords } });
      }
    });
  } catch {
    done();
  }
}
const logger = {
  transcription: {
    debug: (message: string, metadata?: LogMetadata) => log('debug', message, metadata),
    info: (message: string, metadata?: LogMetadata) => log('info', message, metadata),
    warn: (message: string, metadata?: LogMetadata) => log('warn', message, metadata),
    error: (message: string, metadata?: LogMetadata) => log('error', message, metadata),
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
    logger.transcription.info('Whisper GPU policy resolved', {
      context: { useGpu: gpuDecision.useGpu, platform: process.platform, arch: process.arch },
    });

    whisperInstance = new Whisper(modelPath, { gpu: gpuDecision.useGpu });
    await whisperInstance.load();
    currentModelPath = modelPath;
    logger.transcription.info('Whisper model initialized');
  },

  async transcribeAudio(
    aggregatedAudio: Float32Array,
    // Passed through VERBATIM to the addon's full(): any key beyond the five
    // the lane sets today (n_threads, beam_size, vad_*) needs no change here.
    options: WhisperDecodeOptions
  ): Promise<WorkerTranscription> {
    if (!whisperInstance) {
      throw new Error('Whisper instance is not initialized');
    }

    // Pad audio with silence to ensure at least 1 second of audio (16k samples)
    const SAMPLE_RATE = 16000; // Whisper expects 16kHz input
    const originalAudioDurationMs = Math.round((aggregatedAudio.length / SAMPLE_RATE) * 1000);
    const MIN_DURATION_SAMPLES = SAMPLE_RATE * 1 + 4000; // 1 second + extra buffer
    if (aggregatedAudio.length < MIN_DURATION_SAMPLES) {
      const padded = new Float32Array(MIN_DURATION_SAMPLES);
      // Copy the existing audio to the beginning
      padded.set(aggregatedAudio, 0);
      aggregatedAudio = padded;
    }

    const { result } = await whisperInstance.transcribe(aggregatedAudio, options);
    const transcription = await result;

    // Filter out hallucination/no-speech segments
    const segments = transcription as Array<{
      text: string;
      from?: number;
      to?: number;
      noSpeechProb?: number;
    }>;

    const keptTextSegments = segments
      .filter(segment => !shouldDropSegment(segment))
      .filter(segment => segment.text.trim().length > 0);
    const kept = keptTextSegments
      .filter(
        (segment): segment is typeof segment & { from: number; to: number } =>
          typeof segment.from === 'number' && typeof segment.to === 'number'
      )
      .map(segment => ({
        text: segment.text,
        from: Math.max(0, Math.min(segment.from, originalAudioDurationMs)),
        to: Math.max(0, Math.min(segment.to, originalAudioDurationMs)),
        noSpeechProb: segment.noSpeechProb,
      }))
      .filter(segment => segment.to > segment.from);
    const droppedCount = segments.length - keptTextSegments.length;

    logger.transcription.debug('Whisper segments processed', {
      context: {
        totalSegments: segments.length,
        keptSegments: kept.length,
        droppedSegments: droppedCount,
        audioDurationMs: originalAudioDurationMs,
      },
    });

    return {
      text: keptTextSegments.map(segment => segment.text).join(''),
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
process.on('message', async (message: WorkerRequest) => {
  const { id, method, args } = message;

  try {
    // Deserialize Float32Array from IPC
    const deserializedArgs = args.map(arg =>
      isSerializedFloat32Array(arg) ? new Float32Array(arg.data) : arg
    );

    if (method in methods) {
      const methodName = method as keyof typeof methods;
      const fn = methods[methodName] as (...args: unknown[]) => Promise<unknown>;
      const result = await fn(...deserializedArgs);
      const response: WorkerResponse = { id, result };
      process.send!(response);
    } else {
      const response: WorkerResponse = { id, error: `Unknown method: ${method}` };
      process.send!(response);
    }
  } catch (error) {
    logger.transcription.error('Whisper worker operation failed', { context: { method }, error });
    const response: WorkerResponse = {
      id,
      error: error instanceof Error ? error.message : String(error),
    };
    process.send!(response);
  }
});

// Send ready signal
logger.transcription.info('Worker process started');
