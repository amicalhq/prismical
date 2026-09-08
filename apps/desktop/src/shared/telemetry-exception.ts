import { ErrorTracking } from '@posthog/core';
import { telemetryStackFrameSchema, type TelemetryStackFrame } from '@prismical/desktop-contracts';
import { sanitizeTelemetryError, sanitizeTelemetrySourceLocation } from './telemetry-payload';

const builders = {
  main: new ErrorTracking.ErrorPropertiesBuilder(
    [new ErrorTracking.ErrorCoercer()],
    ErrorTracking.createStackParser('node:javascript', ErrorTracking.nodeStackLineParser)
  ),
  renderer: new ErrorTracking.ErrorPropertiesBuilder(
    [new ErrorTracking.ErrorCoercer()],
    ErrorTracking.createDefaultStackParser()
  ),
};
export type ProjectedTelemetryError = Error & { frames: TelemetryStackFrame[] };

/** Parse where the error originated, before removing paths. This preserves
 * injected source-map chunk IDs across IPC without sending source content. */
export function projectTelemetryException(
  input: unknown,
  runtime: 'main' | 'renderer'
): ProjectedTelemetryError {
  const safe = sanitizeTelemetryError(input);
  let frames: unknown = [];
  try {
    const value = input as { frames?: unknown; stack?: unknown } | null;
    if (Array.isArray(value?.frames)) {
      frames = value.frames;
    } else if (typeof value?.stack === 'string') {
      const original = new Error(safe.message);
      original.name = safe.name;
      original.stack = value.stack.slice(0, 8192);
      frames = builders[runtime].buildFromUnknown(original).$exception_list[0]?.stacktrace?.frames;
    }
  } catch {
    /* A malformed error can still be reported without its stack. */
  }
  const projected: TelemetryStackFrame[] = [];
  if (Array.isArray(frames)) {
    for (const candidate of frames.slice(-20)) {
      if (!candidate || typeof candidate !== 'object') continue;
      try {
        const parsed = telemetryStackFrameSchema.safeParse({
          filename: candidate.filename,
          lineno: candidate.lineno,
          colno: candidate.colno,
          ...(candidate.chunk_id === undefined ? {} : { chunk_id: candidate.chunk_id }),
          ...(candidate.platform === undefined ? {} : { platform: candidate.platform }),
        });
        if (!parsed.success) continue;
        const filename = sanitizeTelemetrySourceLocation(parsed.data.filename);
        if (filename) projected.push({ ...parsed.data, filename });
      } catch {
        /* Ignore malformed frame getters without losing the error. */
      }
    }
  }
  return Object.assign(safe, { frames: projected });
}
