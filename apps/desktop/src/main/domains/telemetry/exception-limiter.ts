import { createHash } from 'node:crypto';
import type { ProjectedTelemetryError } from '../../../shared/telemetry-exception';

/** Bound repeated error reports independently; product events never use this. */
export const makeExceptionLimiter = () => {
  const entries = new Map<string, { started: number; count: number }>();
  return {
    clear: () => entries.clear(),
    admit(error: ProjectedTelemetryError, source: string, now = Date.now()): boolean {
      const key = createHash('sha256')
        .update(`${source}\n${error.name}\n${JSON.stringify(error.frames)}`)
        .digest('hex');
      const entry = entries.get(key);
      if (entry && now - entry.started < 60_000) {
        if (entry.count >= 3) return false;
        entry.count++;
        return true;
      }
      if (!entry && entries.size >= 128) entries.delete(entries.keys().next().value!);
      entries.set(key, { started: now, count: 1 });
      return true;
    },
  };
};
