import { desktopFetch } from '../../infra/http/client';
import { QueuedPostHog, TELEMETRY_QUEUE_CAPACITY } from './posthog-queue';
import type { ProjectedTelemetryError } from '../../../shared/telemetry-exception';

export interface SinkCapture {
  readonly distinctId: string;
  readonly event: string;
  readonly properties?: Record<string, unknown>;
  readonly groups?: Record<string, string>;
}
export interface SinkIdentify {
  readonly distinctId: string;
  readonly properties?: Record<string, unknown>;
}
export interface PostHogSink {
  capture(args: SinkCapture): void;
  captureException(
    error: ProjectedTelemetryError,
    distinctId: string,
    properties?: Record<string, unknown>
  ): void;
  identify(args: SinkIdentify): void;
  /** Invalidate pending work and abort in-flight requests on policy/identity change. */
  discard(): void;
  shutdown(timeoutMs?: number): Promise<void>;
}
export type MakePostHogSink = (
  apiKey: string,
  host: string,
  isAllowed: () => boolean,
  onQueueDrop: (count: number) => void
) => PostHogSink;

/** A session owns its client. A discarded client can never send on re-enable. */
export const makePostHogNodeSink: MakePostHogSink = (apiKey, host, isAllowed, onQueueDrop) => {
  let discarded = false;
  const abort = new AbortController();
  const allowed = () => !discarded && isAllowed();
  const posthog = new QueuedPostHog(
    apiKey,
    {
      host,
      flushAt: 20,
      flushInterval: 10_000,
      maxQueueSize: TELEMETRY_QUEUE_CAPACITY,
      requestTimeout: 3_000,
      fetchRetryCount: 1,
      disableGeoip: true,
      enableExceptionAutocapture: false,
      before_send: event => {
        if (!allowed()) return null;
        return event;
      },
      fetch: async (url, options) => {
        // A successful local acknowledgement discards stale batches without retries.
        if (!allowed()) return new Response('{}', { status: 200 });
        const signal = options.signal
          ? AbortSignal.any([abort.signal, options.signal])
          : abort.signal;
        return desktopFetch(url, { ...options, signal });
      },
    },
    () => onQueueDrop(1)
  );
  return {
    capture: args => {
      if (allowed()) posthog.capture(args);
    },
    captureException: (safe, distinctId, properties) => {
      if (!allowed()) return;
      posthog.captureException(safe, distinctId, {
        ...properties,
        // The originating renderer has already resolved its injected chunk IDs.
        // Override SDK frames so main never substitutes its own synthetic stack.
        $exception_list: [
          {
            type: safe.name,
            value: safe.message,
            mechanism: { type: 'generic', handled: true },
            stacktrace: { type: 'raw', frames: safe.frames },
          },
        ],
      });
    },
    identify: args => {
      if (allowed()) posthog.identify(args);
    },
    discard: () => {
      discarded = true;
      abort.abort();
      void posthog.shutdown(500).catch(() => undefined);
    },
    shutdown: timeoutMs => posthog.shutdown(timeoutMs),
  };
};
